import { dirname, isAbsolute, join, resolve } from 'node:path';

import * as Predicate from 'effect/Predicate';

import { stripAnsi } from '../lib/ansi.js';

import type { KacheGcReport, KacheKeyTiming, KacheStoreLimitReport } from './protocol.js';

/**
 * Pure readers behind the kache store-pressure panel (#92): kache's size
 * syntax, its config file, `gc_stats.json`, the eviction warnings in its
 * logs, and the `key_ms` distribution. `kache-status.ts` does the file I/O
 * and feeds these; nothing here touches the disk.
 */

/**
 * kache parses sizes with the `bytesize` crate: an optional decimal
 * fraction, then a unit where `K`/`KB` are powers of ten and `Ki`/`KiB`
 * powers of two; a bare integer is bytes. Anything else is not a size kache
 * would accept (it warns and falls through to its default), so null.
 */
const sizeUnits: Readonly<Record<string, number>> = {
  b: 1,
  k: 1e3,
  kb: 1e3,
  m: 1e6,
  mb: 1e6,
  g: 1e9,
  gb: 1e9,
  t: 1e12,
  tb: 1e12,
  p: 1e15,
  pb: 1e15,
  ki: 1024,
  kib: 1024,
  mi: 1024 ** 2,
  mib: 1024 ** 2,
  gi: 1024 ** 3,
  gib: 1024 ** 3,
  ti: 1024 ** 4,
  tib: 1024 ** 4,
  pi: 1024 ** 5,
  pib: 1024 ** 5,
};

export const parseKacheSize = (raw: string): number | null => {
  const text = raw.trim();
  if (/^\d+$/u.test(text)) {
    return Number(text);
  }
  const match = /^(\d+(?:\.\d+)?)\s*([A-Za-z]+)$/u.exec(text);
  if (match === null || match[1] === undefined || match[2] === undefined) {
    return null;
  }
  const factor = sizeUnits[match[2].toLowerCase()];
  return factor === undefined ? null : Math.floor(Number(match[1]) * factor);
};

export interface KacheConfigValues {
  readonly localMaxSize: string | null;
  readonly localStore: string | null;
  /** `ignore_env = true` makes kache disregard `KACHE_*` overrides. */
  readonly ignoreEnv: boolean;
}

const quotedValue = (content: string, key: string): string | null => {
  const match = new RegExp(`^\\s*${key}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'mu').exec(content);
  if (match === null) {
    return null;
  }
  const value = match[1] ?? match[2] ?? '';
  return value.length === 0 ? null : value;
};

/**
 * The three `[cache]` keys the panel needs, by tolerant line match (the same
 * approach `status.ts` takes for `local_store`: one quoted scalar each, so a
 * TOML parser dependency buys nothing).
 */
export const parseKacheConfig = (content: string): KacheConfigValues => ({
  ignoreEnv: /^\s*ignore_env\s*=\s*true\b/mu.test(content),
  localMaxSize: quotedValue(content, 'local_max_size'),
  localStore: quotedValue(content, 'local_store'),
});

const expandHome = (path: string, home: string): string =>
  path === '~' ? home : path.startsWith('~/') ? join(home, path.slice(2)) : path;

export interface ResolveKacheStoreLimitInput {
  readonly indexPath: string;
  readonly configPath: string;
  /** Config file text, or null when it could not be read. */
  readonly configContent: string | null;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly home: string;
}

/**
 * The budget kache enforces on this index's store, following kache's own
 * precedence — `KACHE_MAX_SIZE` (unless the config sets `ignore_env`), then
 * `[cache] local_max_size` — and mirroring its fall-through on a value it
 * would reject (`none`, a malformed size). What cannot be read honestly is
 * reported unknown with the reason; the disk-share default kache computes
 * when nothing is set is its business, not a number to reproduce here.
 */
export const resolveKacheStoreLimit = (input: ResolveKacheStoreLimitInput): KacheStoreLimitReport => {
  const config = input.configContent === null ? null : parseKacheConfig(input.configContent);
  if (config !== null && config.localStore !== null) {
    const configured = resolve(expandHome(config.localStore, input.home));
    const indexDir = resolve(dirname(input.indexPath));
    if (configured !== indexDir) {
      return {
        detail: `${input.configPath} names store ${configured}, not ${indexDir}`,
        kind: 'unknown',
        reason: 'store-mismatch',
      };
    }
  }
  const envValue = input.env.KACHE_MAX_SIZE;
  if (envValue !== undefined && config?.ignoreEnv !== true) {
    // `none` and malformed values fall through to the file, as in kache.
    const bytes = parseKacheSize(envValue);
    if (bytes !== null) {
      return { bytes, kind: 'known', source: 'KACHE_MAX_SIZE' };
    }
  }
  if (config === null) {
    return { detail: `no kache config at ${input.configPath}`, kind: 'unknown', reason: 'config-missing' };
  }
  if (config.localMaxSize === null) {
    return {
      detail: `${input.configPath} sets no local_max_size; kache applies its own default`,
      kind: 'unknown',
      reason: 'not-configured',
    };
  }
  const bytes = parseKacheSize(config.localMaxSize);
  if (bytes === null) {
    return {
      detail: `local_max_size ${JSON.stringify(config.localMaxSize)} in ${input.configPath} is not a size kache accepts`,
      kind: 'unknown',
      reason: 'unparsable',
    };
  }
  return { bytes, kind: 'known', source: input.configPath };
};

/**
 * Where kache reads its config: `KACHE_CONFIG` when set, otherwise
 * `$XDG_CONFIG_HOME/kache/config.toml`, falling back to
 * `~/.config/kache/config.toml`.
 */
export const kacheConfigPathFor = (
  env: Readonly<Record<string, string | undefined>>,
  home: string,
): string => {
  const override = env.KACHE_CONFIG;
  if (override !== undefined && override.trim().length > 0) {
    const expanded = expandHome(override.trim(), home);
    return isAbsolute(expanded) ? expanded : resolve(expanded);
  }
  const configHome =
    env.XDG_CONFIG_HOME !== undefined && env.XDG_CONFIG_HOME.length > 0
      ? env.XDG_CONFIG_HOME
      : join(home, '.config');
  return join(configHome, 'kache', 'config.toml');
};

const nonNegativeOrNull = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

const unparsableGc: KacheGcReport = { kind: 'unavailable', reason: 'unparsable' };

/**
 * kache's `gc_stats.json`: its serialized `GcStats` (`entries_evicted`,
 * `bytes_freed`, `blobs_removed`, `duration_ms`, `skipped`, the pinned /
 * unreclaimable counts) plus the `last_run` timestamp. Evictions abandoned
 * with an error are not in it — kache only logs those — so the caller fills
 * `evictionErrors` from the logs.
 */
export const parseGcStats = (text: string): KacheGcReport => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return unparsableGc;
  }
  if (!Predicate.isObject(parsed)) {
    return unparsableGc;
  }
  const lastRunAtMs =
    typeof parsed.last_run === 'string'
      ? Date.parse(parsed.last_run)
      : typeof parsed.last_run === 'number'
        ? parsed.last_run
        : Number.NaN;
  if (!Number.isFinite(lastRunAtMs)) {
    return unparsableGc;
  }
  return {
    kind: 'ran',
    lastRunAtMs,
    durationMs: nonNegativeOrNull(parsed.duration_ms),
    entriesEvicted: nonNegativeOrNull(parsed.entries_evicted),
    bytesFreed: nonNegativeOrNull(parsed.bytes_freed),
    diskBytesReclaimed: nonNegativeOrNull(parsed.disk_bytes_reclaimed),
    blobsRemoved: nonNegativeOrNull(parsed.blobs_removed),
    declined: parsed.skipped === true,
    entriesPinned: nonNegativeOrNull(parsed.entries_pinned),
    entriesUnreclaimable: nonNegativeOrNull(parsed.entries_unreclaimable),
    evictionErrors: null,
    evictionErrorSample: null,
  };
};

/** Slack around a GC run when matching log lines to it: `last_run` may mark either end. */
export const gcLogWindowSlackMs = 60_000;

export interface EvictionSkips {
  readonly count: number;
  /** The error text of the skips, e.g. `database is locked`; null when none. */
  readonly sample: string | null;
}

const skipLinePattern = /^(\S+)\s.*?gc: skipping eviction of \S+?:\s*(.+)$/u;

/**
 * Counts kache's `gc: skipping eviction of <key>: <error>` warnings whose
 * timestamp falls inside `[fromMs, toMs]`. Lines may carry ANSI colour (the
 * daemon log does) and the error text a chained `: Error code N: …`
 * suffix, which is dropped from the sample.
 */
export const countEvictionSkips = (
  logText: string,
  fromMs: number,
  toMs: number,
): EvictionSkips => {
  let count = 0;
  let sample: string | null = null;
  for (const rawLine of logText.split('\n')) {
    const match = skipLinePattern.exec(stripAnsi(rawLine));
    if (match === null || match[1] === undefined || match[2] === undefined) {
      continue;
    }
    const atMs = Date.parse(match[1]);
    if (!Number.isFinite(atMs) || atMs < fromMs || atMs > toMs) {
      continue;
    }
    count += 1;
    if (sample === null) {
      const reason = match[2].split(': Error code', 1)[0]?.trim() ?? '';
      sample = reason.length === 0 ? null : reason;
    }
  }
  return { count, sample };
};

/** Log window of a GC run: the run's duration on either side of `last_run`, plus slack. */
export const gcLogWindow = (
  lastRunAtMs: number,
  durationMs: number | null,
): { readonly fromMs: number; readonly toMs: number } => {
  const span = (durationMs ?? 0) + gcLogWindowSlackMs;
  return { fromMs: lastRunAtMs - span, toMs: lastRunAtMs + span };
};

export const keyTimingFrom = (samples: readonly number[]): KacheKeyTiming | null => {
  if (samples.length === 0) {
    return null;
  }
  const sorted = [...samples].sort((left, right) => left - right);
  return {
    count: sorted.length,
    meanMs: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
    p95Ms: sorted[Math.floor((sorted.length - 1) * 0.95)] ?? 0,
  };
};
