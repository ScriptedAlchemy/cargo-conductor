import { describe, expect, it } from 'effect-rstest';

import {
  countEvictionSkips,
  gcLogWindow,
  gcLogWindowSlackMs,
  kacheConfigPathFor,
  keyTimingFrom,
  parseGcStats,
  parseKacheConfig,
  parseKacheSize,
  resolveKacheStoreLimit,
} from '../src/daemon/kache-pressure.js';

const home = '/home/agent';
const indexPath = '/fast/cache/kache/index.db';
const configPath = '/home/agent/.config/kache/config.toml';

describe('parseKacheSize', () => {
  it('follows bytesize: decimal SI units and binary IEC units', () => {
    expect(parseKacheSize('429GiB')).toBe(429 * 1024 ** 3);
    expect(parseKacheSize('600 GB')).toBe(600e9);
    expect(parseKacheSize('1.5TiB')).toBe(Math.floor(1.5 * 1024 ** 4));
    expect(parseKacheSize('50g')).toBe(50e9);
    expect(parseKacheSize('4096')).toBe(4096);
  });

  it('rejects what kache would reject', () => {
    expect(parseKacheSize('none')).toBeNull();
    expect(parseKacheSize('')).toBeNull();
    expect(parseKacheSize('12 parsecs')).toBeNull();
    expect(parseKacheSize('-1GiB')).toBeNull();
  });
});

describe('parseKacheConfig', () => {
  it('reads the [cache] scalars the panel needs, tolerating quote style and comments', () => {
    const config = parseKacheConfig(`
# kache config
[cache]
local_store = '/fast/cache/kache' # store
local_max_size = "429GiB"
ignore_env = true
`);
    expect(config).toEqual({
      ignoreEnv: true,
      localMaxSize: '429GiB',
      localStore: '/fast/cache/kache',
    });
  });

  it('treats absent or empty values as unset', () => {
    expect(parseKacheConfig('[cache]\nlocal_max_size = ""\n')).toEqual({
      ignoreEnv: false,
      localMaxSize: null,
      localStore: null,
    });
  });
});

describe('resolveKacheStoreLimit', () => {
  it('reads local_max_size from the config that owns this store', () => {
    expect(
      resolveKacheStoreLimit({
        configContent: '[cache]\nlocal_store = "/fast/cache/kache"\nlocal_max_size = "429GiB"\n',
        configPath,
        env: {},
        home,
        indexPath,
      }),
    ).toEqual({ bytes: 429 * 1024 ** 3, kind: 'known', source: configPath });
  });

  it('lets KACHE_MAX_SIZE win unless the config ignores the environment', () => {
    const configContent = '[cache]\nlocal_max_size = "429GiB"\n';
    expect(
      resolveKacheStoreLimit({
        configContent,
        configPath,
        env: { KACHE_MAX_SIZE: '1TB' },
        home,
        indexPath,
      }),
    ).toEqual({ bytes: 1e12, kind: 'known', source: 'KACHE_MAX_SIZE' });
    expect(
      resolveKacheStoreLimit({
        configContent: `${configContent}ignore_env = true\n`,
        configPath,
        env: { KACHE_MAX_SIZE: '1TB' },
        home,
        indexPath,
      }),
    ).toMatchObject({ kind: 'known', source: configPath });
    // A value kache rejects falls through to the file, as kache does.
    expect(
      resolveKacheStoreLimit({
        configContent,
        configPath,
        env: { KACHE_MAX_SIZE: 'none' },
        home,
        indexPath,
      }),
    ).toMatchObject({ kind: 'known', source: configPath });
  });

  it('reports the limit unknown, with the reason, instead of guessing', () => {
    expect(
      resolveKacheStoreLimit({ configContent: null, configPath, env: {}, home, indexPath }),
    ).toMatchObject({ kind: 'unknown', reason: 'config-missing' });
    expect(
      resolveKacheStoreLimit({
        configContent: '[cache]\nlocal_store = "/fast/cache/kache"\n',
        configPath,
        env: {},
        home,
        indexPath,
      }),
    ).toMatchObject({ kind: 'unknown', reason: 'not-configured' });
    expect(
      resolveKacheStoreLimit({
        configContent: '[cache]\nlocal_max_size = "none"\n',
        configPath,
        env: {},
        home,
        indexPath,
      }),
    ).toMatchObject({ kind: 'unknown', reason: 'unparsable' });
    // A config for a different store says nothing about this index.
    expect(
      resolveKacheStoreLimit({
        configContent: '[cache]\nlocal_store = "~/other-store"\nlocal_max_size = "10GiB"\n',
        configPath,
        env: { KACHE_MAX_SIZE: '1TB' },
        home,
        indexPath,
      }),
    ).toMatchObject({
      detail: expect.stringContaining('/home/agent/other-store'),
      kind: 'unknown',
      reason: 'store-mismatch',
    });
  });
});

describe('kacheConfigPathFor', () => {
  it('prefers KACHE_CONFIG, then XDG_CONFIG_HOME, then ~/.config', () => {
    expect(kacheConfigPathFor({ KACHE_CONFIG: '~/kache.toml' }, home)).toBe('/home/agent/kache.toml');
    expect(kacheConfigPathFor({ XDG_CONFIG_HOME: '/xdg' }, home)).toBe('/xdg/kache/config.toml');
    expect(kacheConfigPathFor({}, home)).toBe(configPath);
  });
});

describe('parseGcStats', () => {
  it('reads kache gc_stats.json as written on disk', () => {
    const report = parseGcStats(`{
  "last_run": "2026-09-04T23:55:41.264981906+00:00",
  "entries_evicted": 0,
  "bytes_freed": 1050074,
  "disk_bytes_reclaimed": 0,
  "blobs_removed": 2,
  "duration_ms": 6849
}`);
    expect(report).toEqual({
      kind: 'ran',
      lastRunAtMs: Date.parse('2026-09-04T23:55:41.264Z'),
      durationMs: 6_849,
      entriesEvicted: 0,
      bytesFreed: 1_050_074,
      diskBytesReclaimed: 0,
      blobsRemoved: 2,
      declined: false,
      entriesPinned: null,
      entriesUnreclaimable: null,
      evictionErrors: null,
      evictionErrorSample: null,
    });
  });

  it('surfaces a GC that declined to evict and the newer counters', () => {
    expect(
      parseGcStats(
        JSON.stringify({
          last_run: '2026-09-04T00:00:00Z',
          skipped: true,
          entries_pinned: 12,
          entries_unreclaimable: 3,
          duration_ms: 83_000,
        }),
      ),
    ).toMatchObject({
      declined: true,
      durationMs: 83_000,
      entriesPinned: 12,
      entriesUnreclaimable: 3,
      kind: 'ran',
    });
  });

  it('is unparsable rather than empty on bad JSON or a missing last_run', () => {
    expect(parseGcStats('{not json')).toEqual({ kind: 'unavailable', reason: 'unparsable' });
    expect(parseGcStats('[]')).toEqual({ kind: 'unavailable', reason: 'unparsable' });
    expect(parseGcStats('{"duration_ms": 5}')).toEqual({
      kind: 'unavailable',
      reason: 'unparsable',
    });
  });
});

describe('countEvictionSkips', () => {
  const at = Date.parse('2026-09-02T00:05:38.508Z');
  const log = [
    `2026-09-02T00:05:38.508258Z  WARN kache::gc: gc: skipping eviction of abc123: database is locked: Error code 5: The database file is locked`,
    // The daemon log colours its lines.
    `\u001b[2m2026-09-02T00:05:39.100000Z\u001b[0m \u001b[33m WARN\u001b[0m \u001b[2mkache::gc\u001b[0m\u001b[2m:\u001b[0m gc: skipping eviction of def456: database is locked`,
    `2026-09-02T00:05:40.000000Z  INFO kache::gc: gc: evicted 3 entries`,
    `2026-08-29T23:18:43.436836Z  WARN kache::gc: gc: skipping eviction of old000: disk I/O error`,
  ].join('\n');

  it('counts only the skips inside the window and keeps the bare error as the sample', () => {
    expect(countEvictionSkips(log, at - 1_000, at + 5_000)).toEqual({
      count: 2,
      sample: 'database is locked',
    });
  });

  it('reports none when the window misses every skip', () => {
    expect(countEvictionSkips(log, at + 60_000, at + 120_000)).toEqual({ count: 0, sample: null });
    expect(countEvictionSkips('', at, at + 1)).toEqual({ count: 0, sample: null });
  });

  it('pads the run window with its duration on both sides plus slack', () => {
    expect(gcLogWindow(1_000_000, 83_000)).toEqual({
      fromMs: 1_000_000 - 83_000 - gcLogWindowSlackMs,
      toMs: 1_000_000 + 83_000 + gcLogWindowSlackMs,
    });
  });
});

describe('keyTimingFrom', () => {
  it('summarises key_ms samples as count, mean and nearest-rank p95', () => {
    const samples = Array.from({ length: 100 }, (_, index) => index + 1);
    expect(keyTimingFrom(samples)).toEqual({ count: 100, meanMs: 50.5, p95Ms: 95 });
    expect(keyTimingFrom([1_000])).toEqual({ count: 1, meanMs: 1_000, p95Ms: 1_000 });
  });

  it('is null with no samples', () => {
    expect(keyTimingFrom([])).toBeNull();
  });
});
