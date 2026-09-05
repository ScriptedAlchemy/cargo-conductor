import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';

import { describe, expect, it } from 'effect-rstest';
import * as Effect from 'effect/Effect';
import * as Schedule from 'effect/Schedule';

import {
  createKacheSnapshotReader,
  createKacheStatus,
  readKacheEventPriors,
} from '../src/daemon/kache-status.js';

const createIndex = (indexPath: string, rows: readonly (readonly [string, string, number])[]) => {
  const database = new DatabaseSync(indexPath);
  database.exec('CREATE TABLE entries (crate_name TEXT, profile TEXT, compile_time_ms INTEGER)');
  const insert = database.prepare(
    'INSERT INTO entries (crate_name, profile, compile_time_ms) VALUES (?, ?, ?)',
  );
  for (const [crate, profile, ms] of rows) {
    insert.run(crate, profile, ms);
  }
  database.close();
};

describe('createKacheSnapshotReader', () => {
  it('aggregates one index scan and a bounded event tail into status and priors', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cc-kache-status-'));
    const indexPath = join(root, 'index.db');
    const eventsPath = join(root, 'events.jsonl');
    const nowMs = Date.parse('2026-09-01T12:00:00.000Z');
    try {
      createIndex(indexPath, [
        ['alpha', 'dev', 100],
        ['alpha', 'dev', 300],
        ['beta', 'release', 2_000],
        ['gamma', 'debug', 1_000],
      ]);

      const event = (offsetMs: number, value: Readonly<Record<string, unknown>>): string =>
        JSON.stringify({ ts: new Date(nowMs - offsetMs).toISOString(), ...value });
      writeFileSync(
        eventsPath,
        `${[
          'discarded'.repeat(1_000),
          event(10 * 60_000, { crate_name: 'old', event: 'heartbeat', root: '/old' }),
          event(4_000, { crate_name: 'alpha', event: 'heartbeat', root: '/work/a' }),
          event(3_000, { crate_name: 'beta', event: 'heartbeat', root: '/work/a' }),
          event(2_000, { crate_name: 'gamma', event: 'heartbeat', root: '/work/b' }),
          event(1_000, { crate_name: 'beta', compile_time_ms: 2_100, profile: 'release' }),
          '{malformed',
        ].join('\n')}\n`,
      );

      const snapshot = await createKacheSnapshotReader(indexPath, {
        env: {},
        home: root,
        maxEventBytes: 2_048,
      }).read(nowMs);

      expect(snapshot.status).toEqual({
        available: true,
        distinctCrates: 3,
        entryCount: 4,
        eventsFreshMs: 1_000,
        indexSizeBytes: expect.any(Number),
        pressure: {
          // No `blobs` table, no gc_stats.json, no kache config: every part
          // of the panel says why rather than reading as an empty store.
          gc: { kind: 'unavailable', reason: 'missing' },
          keyTiming: null,
          limit: {
            detail: expect.stringContaining('config.toml'),
            kind: 'unknown',
            reason: 'config-missing',
          },
          storeBytes: null,
        },
        recentHeartbeatRoots: [
          { count: 2, root: '/work/a' },
          { count: 1, root: '/work/b' },
        ],
        topCrates: [
          { crate: 'beta', ms: 2_000, profile: 'release' },
          { crate: 'gamma', ms: 1_000, profile: 'debug' },
          { crate: 'alpha', ms: 300, profile: 'dev' },
        ],
      });
      expect(snapshot.status.indexSizeBytes).toBeGreaterThan(0);
      expect(snapshot.eventPriors.bytesRead).toBeLessThanOrEqual(2_048);
      expect(snapshot.indexPriors.compileTimeMs('alpha', ['dev'])).toBe(300);
      expect(snapshot.eventPriors.compileTimeMs('beta', ['release'])).toBe(2_100);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('caps slowest crates per profile instead of ranking across profiles', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cc-kache-status-profiles-'));
    const indexPath = join(root, 'index.db');
    try {
      // Seven release timings, all slower than every dev timing: a global
      // top-N would evict dev entirely.
      createIndex(indexPath, [
        ...Array.from(
          { length: 7 },
          (_, index) => [`release-${index}`, 'release', 100_000 - index] as const,
        ),
        ['dev-a', 'dev', 900],
        ['dev-b', 'dev', 800],
      ]);

      const { status } = await createKacheSnapshotReader(indexPath).read(1_000);
      const byProfile = new Map<string, number>();
      for (const row of status.topCrates) {
        byProfile.set(row.profile, (byProfile.get(row.profile) ?? 0) + 1);
      }
      expect(byProfile.get('release')).toBe(5);
      expect(byProfile.get('dev')).toBe(2);
      expect(status.topCrates.map((row) => row.crate)).toContain('dev-b');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports an unavailable configured index without throwing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cc-kache-status-missing-'));
    try {
      const snapshot = await createKacheSnapshotReader(join(root, 'missing.db')).read(1_000);
      expect(snapshot.status.available).toBe(false);
      expect(snapshot.status.entryCount).toBe(0);
      expect(snapshot.status.topCrates).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports unavailable when the index file is not a SQLite database', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cc-kache-status-corrupt-'));
    const indexPath = join(root, 'index.db');
    try {
      writeFileSync(indexPath, 'not a sqlite database at all');
      const snapshot = await createKacheSnapshotReader(indexPath).read(1_000);
      expect(snapshot.status.available).toBe(false);
      expect(snapshot.indexPriors.compileTimeMs('alpha', ['dev'])).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports unavailable on schema drift without losing event priors', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cc-kache-status-schema-'));
    const indexPath = join(root, 'index.db');
    const nowMs = Date.parse('2026-09-01T12:00:00.000Z');
    try {
      const database = new DatabaseSync(indexPath);
      database.exec('CREATE TABLE entries (crate_name TEXT)');
      database.close();
      writeFileSync(
        join(root, 'events.jsonl'),
        `${JSON.stringify({
          ts: new Date(nowMs - 1_000).toISOString(),
          crate_name: 'alpha',
          profile: 'dev',
          compile_time_ms: 3_000,
        })}\n`,
      );
      const snapshot = await createKacheSnapshotReader(indexPath).read(nowMs);
      expect(snapshot.status.available).toBe(false);
      expect(snapshot.indexPriors.compileTimeMs('alpha', ['dev'])).toBeNull();
      // The events sidecar is independent of index health.
      expect(snapshot.eventPriors.compileTimeMs('alpha', ['dev'])).toBe(3_000);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('parses only the bytes appended since the previous refresh', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cc-kache-status-incremental-'));
    const indexPath = join(root, 'index.db');
    const eventsPath = join(root, 'events.jsonl');
    const nowMs = Date.parse('2026-09-01T12:00:00.000Z');
    const line = (value: Readonly<Record<string, unknown>>): string =>
      `${JSON.stringify({ ts: new Date(nowMs - 1_000).toISOString(), ...value })}\n`;
    try {
      createIndex(indexPath, [['alpha', 'dev', 100]]);
      writeFileSync(eventsPath, line({ crate_name: 'alpha', profile: 'dev', compile_time_ms: 400 }));
      const reader = createKacheSnapshotReader(indexPath);

      const first = await reader.read(nowMs);
      const firstBytes = first.eventPriors.bytesRead;
      expect(first.eventPriors.sampleCount).toBe(1);
      expect(first.eventPriors.compileTimeMs('alpha', ['dev'])).toBe(400);

      // A partial trailing line is left for the next refresh, never parsed twice.
      const appended = line({ crate_name: 'beta', profile: 'dev', compile_time_ms: 900 });
      appendFileSync(eventsPath, appended.slice(0, 10));
      const partial = await reader.read(nowMs);
      expect(partial.eventPriors.sampleCount).toBe(1);
      expect(partial.eventPriors.bytesRead).toBe(firstBytes);

      appendFileSync(eventsPath, appended.slice(10));
      const second = await reader.read(nowMs);
      expect(second.eventPriors.sampleCount).toBe(2);
      expect(second.eventPriors.bytesRead).toBe(firstBytes + Buffer.byteLength(appended));
      expect(second.eventPriors.compileTimeMs('beta', ['dev'])).toBe(900);
      // Still the same alpha EWMA: the first line was not re-ingested.
      expect(second.eventPriors.compileTimeMs('alpha', ['dev'])).toBe(400);

      // Truncation (kache rotating its sidecar) restarts from the new tail.
      writeFileSync(eventsPath, line({ crate_name: 'gamma', profile: 'dev', compile_time_ms: 50 }));
      const rotated = await reader.read(nowMs);
      expect(rotated.eventPriors.sampleCount).toBe(1);
      expect(rotated.eventPriors.compileTimeMs('alpha', ['dev'])).toBeNull();
      expect(rotated.eventPriors.compileTimeMs('gamma', ['dev'])).toBe(50);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reuses the index aggregate until the index file changes on disk', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cc-kache-status-fingerprint-'));
    const indexPath = join(root, 'index.db');
    try {
      createIndex(indexPath, [['alpha', 'dev', 100]]);
      // Whole-millisecond timestamps so the pin below reproduces them exactly.
      const pinnedAt = new Date(Date.parse('2026-09-01T12:00:00.000Z'));
      utimesSync(indexPath, pinnedAt, pinnedAt);
      const reader = createKacheSnapshotReader(indexPath);
      expect((await reader.read(1_000)).status.entryCount).toBe(1);

      // A second row fits in the same page, so only mtime distinguishes the
      // files; pin it back to prove the aggregate is served from cache.
      const before = statSync(indexPath);
      const database = new DatabaseSync(indexPath);
      database.prepare('INSERT INTO entries VALUES (?, ?, ?)').run('beta', 'dev', 200);
      database.close();
      expect(statSync(indexPath).size).toBe(before.size);
      utimesSync(indexPath, pinnedAt, pinnedAt);
      expect((await reader.read(2_000)).status.entryCount).toBe(1);

      utimesSync(indexPath, pinnedAt, new Date(pinnedAt.getTime() + 5_000));
      expect((await reader.read(3_000)).status.entryCount).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('assembles the store-pressure panel from blobs, gc_stats.json, the GC logs and the config', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cc-kache-status-pressure-'));
    const storeDir = join(root, 'store');
    const indexPath = join(storeDir, 'index.db');
    const nowMs = Date.parse('2026-09-05T00:00:00.000Z');
    const gcRanAt = '2026-09-04T23:55:41.264981906+00:00';
    try {
      mkdirSync(storeDir);
      createIndex(indexPath, [['alpha', 'dev', 100]]);
      const database = new DatabaseSync(indexPath);
      // kache's `blobs` table: hash, size, refcount.
      database.exec('CREATE TABLE blobs (hash TEXT PRIMARY KEY, size INTEGER NOT NULL, refcount INTEGER)');
      database.prepare('INSERT INTO blobs VALUES (?, ?, 1)').run('a', 300 * 1024 ** 3);
      database.prepare('INSERT INTO blobs VALUES (?, ?, 1)').run('b', 241 * 1024 ** 3);
      database.close();
      writeFileSync(
        join(storeDir, 'gc_stats.json'),
        JSON.stringify({
          last_run: gcRanAt,
          entries_evicted: 0,
          bytes_freed: 1_050_074,
          disk_bytes_reclaimed: 0,
          blobs_removed: 2,
          duration_ms: 83_000,
        }),
      );
      // One skip inside the run, one from an older run, one in the other log.
      writeFileSync(
        join(storeDir, 'auto-gc.log'),
        [
          '2026-09-04T23:55:50.000000Z  WARN kache::gc: gc: skipping eviction of aaa: database is locked: Error code 5: The database file is locked',
          '2026-09-01T00:00:00.000000Z  WARN kache::gc: gc: skipping eviction of bbb: database is locked',
          '',
        ].join('\n'),
      );
      writeFileSync(
        join(storeDir, 'daemon.log'),
        '\u001b[2m2026-09-04T23:56:10.000000Z\u001b[0m  WARN kache::gc: gc: skipping eviction of ccc: database is locked\n',
      );
      mkdirSync(join(root, 'config', 'kache'), { recursive: true });
      writeFileSync(
        join(root, 'config', 'kache', 'config.toml'),
        `[cache]\nlocal_store = "${storeDir}"\nlocal_max_size = "429GiB"\n`,
      );
      const event = (offsetMs: number, value: Readonly<Record<string, unknown>>): string =>
        JSON.stringify({ ts: new Date(nowMs - offsetMs).toISOString(), ...value });
      writeFileSync(
        join(storeDir, 'events.jsonl'),
        `${[
          event(3_000, { crate_name: 'alpha', profile: 'dev', compile_time_ms: 400, key_ms: 900 }),
          event(2_000, { crate_name: 'beta', profile: 'dev', compile_time_ms: 400, key_ms: 1_100 }),
          event(1_000, { crate_name: 'gamma', profile: 'dev', compile_time_ms: 400, key_ms: 4_000 }),
        ].join('\n')}\n`,
      );

      const snapshot = await createKacheSnapshotReader(indexPath, {
        env: { XDG_CONFIG_HOME: join(root, 'config') },
        home: root,
      }).read(nowMs);

      expect(snapshot.status.pressure).toEqual({
        gc: {
          kind: 'ran',
          lastRunAtMs: Date.parse(gcRanAt),
          durationMs: 83_000,
          entriesEvicted: 0,
          bytesFreed: 1_050_074,
          diskBytesReclaimed: 0,
          blobsRemoved: 2,
          declined: false,
          entriesPinned: null,
          entriesUnreclaimable: null,
          evictionErrors: 2,
          evictionErrorSample: 'database is locked',
        },
        // Same floor((n - 1) * p) rank as the ledger's percentiles.
        keyTiming: { count: 3, meanMs: 2_000, p95Ms: 1_100 },
        limit: {
          bytes: 429 * 1024 ** 3,
          kind: 'known',
          source: join(root, 'config', 'kache', 'config.toml'),
        },
        storeBytes: 541 * 1024 ** 3,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports unparsable gc_stats.json and an older index without a blobs table honestly', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cc-kache-status-pressure-degraded-'));
    const indexPath = join(root, 'index.db');
    try {
      createIndex(indexPath, [['alpha', 'dev', 100]]);
      writeFileSync(join(root, 'gc_stats.json'), '{"last_run": ');
      const snapshot = await createKacheSnapshotReader(indexPath, { env: {}, home: root }).read(
        1_000,
      );
      expect(snapshot.status.available).toBe(true);
      expect(snapshot.status.pressure).toMatchObject({
        gc: { kind: 'unavailable', reason: 'unparsable' },
        keyTiming: null,
        limit: { kind: 'unknown', reason: 'config-missing' },
        storeBytes: null,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refreshes a large events tail without stalling the event loop', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cc-kache-status-large-'));
    const indexPath = join(root, 'index.db');
    const eventsPath = join(root, 'events.jsonl');
    const nowMs = Date.parse('2026-09-01T12:00:00.000Z');
    const lineCount = 200_000;
    try {
      createIndex(indexPath, [['alpha', 'dev', 100]]);
      const ts = new Date(nowMs - 1_000).toISOString();
      const lines: string[] = [];
      for (let index = 0; index < lineCount; index += 1) {
        lines.push(
          JSON.stringify({
            ts,
            crate_name: `crate-${index % 5_000}`,
            profile: index % 2 === 0 ? 'dev' : 'release',
            compile_time_ms: 100 + (index % 977),
          }),
        );
      }
      writeFileSync(eventsPath, `${lines.join('\n')}\n`);
      const fileBytes = statSync(eventsPath).size;
      const reader = createKacheSnapshotReader(indexPath, { maxEventBytes: fileBytes * 2 });

      let maxGapMs = 0;
      let last = performance.now();
      const probe = setInterval(() => {
        const now = performance.now();
        maxGapMs = Math.max(maxGapMs, now - last);
        last = now;
      }, 1);
      try {
        const snapshot = await reader.read(nowMs);
        expect(snapshot.eventPriors.sampleCount).toBe(lineCount);
        expect(snapshot.eventPriors.bytesRead).toBe(fileBytes);
      } finally {
        clearInterval(probe);
      }
      expect(maxGapMs).toBeLessThan(50);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('readKacheEventPriors', () => {
  it('reads a one-shot tail with the same aggregation as the incremental reader', () => {
    const root = mkdtempSync(join(tmpdir(), 'cc-kache-events-sync-'));
    const eventsPath = join(root, 'events.jsonl');
    try {
      writeFileSync(
        eventsPath,
        `${JSON.stringify({ crate_name: 'alpha', profile: 'dev', compile_time_ms: 400 })}\n`,
      );
      const priors = readKacheEventPriors(eventsPath);
      expect(priors.sampleCount).toBe(1);
      expect(priors.compileTimeMs('alpha', ['dev'])).toBe(400);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('createKacheStatus', () => {
  it.effect('serves null status and empty priors when disabled via an empty path', () =>
    Effect.gen(function* () {
      const service = createKacheStatus({ indexPath: '' });
      yield* service.prewarm;
      const status = yield* service.current;
      const priors = yield* service.priors;
      expect(status).toBeNull();
      expect(priors.indexPriors.compileTimeMs('alpha', ['dev'])).toBeNull();
      expect(priors.eventPriors.sampleCount).toBe(0);
    }));

  it.live('degrades to unavailable when the index disappears after daemon start', () =>
    Effect.gen(function* () {
      const root = yield* Effect.acquireRelease(
        Effect.sync(() => mkdtempSync(join(tmpdir(), 'cc-kache-status-midrun-'))),
        (directory) => Effect.sync(() => rmSync(directory, { recursive: true, force: true })),
      );
      const indexPath = join(root, 'index.db');
      createIndex(indexPath, [['alpha', 'dev', 1_000]]);

      let nowMs = 0;
      const service = createKacheStatus({
        indexPath,
        now: () => nowMs,
        ttlMs: 100,
      });
      yield* service.prewarm;
      const healthy = yield* service.current;
      expect(healthy?.available).toBe(true);

      rmSync(root, { recursive: true, force: true });
      nowMs = 200;
      // The first stale read serves the cached snapshot and forks a refresh
      // that completes asynchronously.
      const stale = yield* service.current;
      expect(stale?.available).toBe(true);
      const degraded = yield* Effect.gen(function* () {
        const status = yield* service.current;
        if (status?.available === false) {
          return status;
        }
        return yield* Effect.fail('still available' as const);
      }).pipe(
        Effect.retry(Schedule.spaced('5 millis').pipe(Schedule.upTo({ times: 400 }))),
        Effect.orDie,
      );
      expect(degraded.available).toBe(false);
      const priors = yield* service.priors;
      expect(priors.indexPriors.compileTimeMs('alpha', ['dev'])).toBeNull();
    }));
});
