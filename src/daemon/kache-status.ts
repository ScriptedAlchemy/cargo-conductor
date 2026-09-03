import { closeSync, fstatSync, openSync, readSync, statSync } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';

import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Predicate from 'effect/Predicate';

import { DaemonConfig } from './config.js';
import type { KacheStatusReport, KacheTopCrate } from './protocol.js';

const defaultEventTailBytes = 8 * 1024 * 1024;
const defaultTtlMs = 60_000;
const heartbeatWindowMs = 5 * 60_000;
/**
 * Slowest crates are selected per profile: dev and release timings are not
 * comparable populations, so a single global top-N would silently rank
 * across profiles and starve the cheaper one out of the report.
 */
const topCratesPerProfile = 5;
const eventEwmaAlpha = 0.25;
/** Bytes read per `FileHandle.read` while consuming the events tail. */
const eventReadChunkBytes = 1024 * 1024;
/** Milliseconds of synchronous line parsing before yielding the event loop. */
const defaultParseSliceMs = 4;
/** Lines parsed between clock checks; keeps the check itself off the hot path. */
const parseSliceCheckEvery = 256;

const finitePositiveMs = (value: number): number | null =>
  Number.isFinite(value) && value > 0 ? value : null;

const eventProfile = (event: Record<PropertyKey, unknown>): string => {
  if (typeof event.profile === 'string' && event.profile.length > 0) {
    return event.profile;
  }
  if (typeof event.root === 'string') {
    const match = /(?:^|[/\\])target[/\\](debug|release)(?:[/\\]|$)/u.exec(event.root);
    if (match?.[1] !== undefined) {
      return match[1];
    }
  }
  return '*';
};

const eventPriorKey = (crateName: string, profile: string): string =>
  `${crateName}\0${profile}`;

export interface KacheIndexPriors {
  readonly compileTimeMs: (crateName: string, profiles: readonly string[]) => number | null;
}

export interface KacheEventPriors {
  /** Bytes of the events sidecar consumed so far by the reader that built these priors. */
  readonly bytesRead: number;
  readonly crateCount: number;
  readonly sampleCount: number;
  readonly compileTimeMs: (crateName: string, profiles: readonly string[]) => number | null;
}

export interface KachePriorSnapshot {
  readonly indexPriors: KacheIndexPriors;
  readonly eventPriors: KacheEventPriors;
}

export interface KacheStatusSnapshot extends KachePriorSnapshot {
  readonly status: KacheStatusReport;
}

export const emptyIndexPriors: KacheIndexPriors = {
  compileTimeMs: () => null,
};

export const emptyEventPriors: KacheEventPriors = {
  bytesRead: 0,
  crateCount: 0,
  sampleCount: 0,
  compileTimeMs: () => null,
};

interface EventAggregate {
  compileEwmaMs: number | null;
  heartbeatMaxMs: number | null;
}

interface HeartbeatSample {
  readonly root: string;
  readonly atMs: number;
}

interface EventReadResult {
  readonly priors: KacheEventPriors;
  readonly eventsFreshMs: number | null;
  readonly recentHeartbeatRoots: KacheStatusReport['recentHeartbeatRoots'];
}

const emptyEventReadResult: EventReadResult = {
  eventsFreshMs: null,
  recentHeartbeatRoots: [],
  priors: emptyEventPriors,
};

const yieldToEventLoop = (): Promise<void> =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });

/**
 * Incremental aggregate over kache `events.jsonl` lines. One instance lives
 * across refreshes so a scan only has to parse the bytes appended since the
 * previous one; `reset` handles rotation and truncation.
 */
class EventTailAggregator {
  #aggregates = new Map<string, EventAggregate>();
  #crates = new Set<string>();
  #heartbeats: HeartbeatSample[] = [];
  #latestEventAtMs: number | null = null;
  #sampleCount = 0;
  #bytesRead = 0;

  reset(): void {
    this.#aggregates = new Map();
    this.#crates = new Set();
    this.#heartbeats = [];
    this.#latestEventAtMs = null;
    this.#sampleCount = 0;
    this.#bytesRead = 0;
  }

  addBytesRead(count: number): void {
    this.#bytesRead += count;
  }

  ingest(line: string): void {
    if (line.length === 0) {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    if (!Predicate.isObject(parsed)) {
      return;
    }
    const eventAtMs =
      typeof parsed.ts === 'string' && Number.isFinite(Date.parse(parsed.ts))
        ? Date.parse(parsed.ts)
        : null;
    if (eventAtMs !== null) {
      this.#latestEventAtMs = Math.max(this.#latestEventAtMs ?? eventAtMs, eventAtMs);
    }
    if (
      parsed.event === 'heartbeat' &&
      typeof parsed.root === 'string' &&
      parsed.root.length > 0 &&
      eventAtMs !== null
    ) {
      this.#heartbeats.push({ root: parsed.root, atMs: eventAtMs });
    }
    if (typeof parsed.crate_name !== 'string') {
      return;
    }
    const crateName = parsed.crate_name;
    if (crateName.length === 0 || crateName === 'unknown') {
      return;
    }
    const key = eventPriorKey(crateName, eventProfile(parsed));
    const aggregate = this.#aggregates.get(key) ?? {
      compileEwmaMs: null,
      heartbeatMaxMs: null,
    };
    const compileMs =
      typeof parsed.compile_time_ms === 'number'
        ? finitePositiveMs(parsed.compile_time_ms)
        : null;
    const heartbeatMs =
      parsed.event === 'heartbeat' && typeof parsed.elapsed_s === 'number'
        ? finitePositiveMs(parsed.elapsed_s * 1_000)
        : null;
    if (compileMs === null && heartbeatMs === null) {
      return;
    }
    if (compileMs !== null) {
      aggregate.compileEwmaMs =
        aggregate.compileEwmaMs === null
          ? compileMs
          : aggregate.compileEwmaMs + eventEwmaAlpha * (compileMs - aggregate.compileEwmaMs);
    }
    if (heartbeatMs !== null) {
      aggregate.heartbeatMaxMs = Math.max(aggregate.heartbeatMaxMs ?? 0, heartbeatMs);
    }
    this.#aggregates.set(key, aggregate);
    this.#crates.add(crateName);
    this.#sampleCount += 1;
  }

  /** Drops heartbeats that can no longer fall inside the recent window. */
  #pruneHeartbeats(nowMs: number): void {
    const oldest = nowMs - heartbeatWindowMs;
    if (this.#heartbeats.length > 0 && this.#heartbeats.some((sample) => sample.atMs < oldest)) {
      this.#heartbeats = this.#heartbeats.filter((sample) => sample.atMs >= oldest);
    }
  }

  result(nowMs: number): EventReadResult {
    this.#pruneHeartbeats(nowMs);
    const heartbeatRoots = new Map<string, number>();
    for (const sample of this.#heartbeats) {
      const age = nowMs - sample.atMs;
      if (age >= 0 && age <= heartbeatWindowMs) {
        heartbeatRoots.set(sample.root, (heartbeatRoots.get(sample.root) ?? 0) + 1);
      }
    }
    const aggregates = this.#aggregates;
    return {
      eventsFreshMs:
        this.#latestEventAtMs === null ? null : Math.max(0, nowMs - this.#latestEventAtMs),
      recentHeartbeatRoots: [...heartbeatRoots]
        .map(([root, count]) => ({ root, count }))
        .sort((left, right) => right.count - left.count || left.root.localeCompare(right.root)),
      priors: {
        bytesRead: this.#bytesRead,
        crateCount: this.#crates.size,
        sampleCount: this.#sampleCount,
        compileTimeMs: (crateName, profiles) => {
          let value: number | null = null;
          for (const profile of [...profiles, '*']) {
            const aggregate = aggregates.get(eventPriorKey(crateName, profile));
            if (aggregate === undefined) {
              continue;
            }
            const timing = Math.max(
              aggregate.compileEwmaMs ?? 0,
              aggregate.heartbeatMaxMs ?? 0,
            );
            if (timing > 0) {
              value = Math.max(value ?? 0, timing);
            }
          }
          return value;
        },
      },
    };
  }
}

/**
 * One-shot synchronous tail read. Test and calibration helper only: the
 * daemon uses `createKacheSnapshotReader`, which never blocks the event loop.
 */
const readEventTailSync = (
  eventsPath: string,
  nowMs: number,
  maxBytes: number,
): EventReadResult => {
  let fileDescriptor: number | undefined;
  try {
    fileDescriptor = openSync(eventsPath, 'r');
    const fileBytes = fstatSync(fileDescriptor).size;
    const requestedBytes =
      Number.isFinite(maxBytes) && maxBytes > 0 ? Math.floor(maxBytes) : defaultEventTailBytes;
    const bytesToRead = Math.min(fileBytes, requestedBytes);
    const start = Math.max(0, fileBytes - bytesToRead);
    const buffer = Buffer.allocUnsafe(bytesToRead);
    let bytesRead = 0;
    while (bytesRead < bytesToRead) {
      const count = readSync(
        fileDescriptor,
        buffer,
        bytesRead,
        bytesToRead - bytesRead,
        start + bytesRead,
      );
      if (count === 0) {
        break;
      }
      bytesRead += count;
    }
    let text = buffer.subarray(0, bytesRead).toString('utf8');
    if (start > 0) {
      const firstNewline = text.indexOf('\n');
      text = firstNewline === -1 ? '' : text.slice(firstNewline + 1);
    }
    const aggregator = new EventTailAggregator();
    aggregator.addBytesRead(bytesRead);
    for (const line of text.split('\n')) {
      aggregator.ingest(line);
    }
    return aggregator.result(nowMs);
  } catch {
    return emptyEventReadResult;
  } finally {
    if (fileDescriptor !== undefined) {
      try {
        closeSync(fileDescriptor);
      } catch {
        // Kache status is best-effort; close failures do not affect the daemon.
      }
    }
  }
};

export const readKacheEventPriors = (
  eventsPath: string,
  maxBytes = defaultEventTailBytes,
): KacheEventPriors => readEventTailSync(eventsPath, Date.now(), maxBytes).priors;

interface IndexReadResult {
  readonly available: boolean;
  readonly entryCount: number;
  readonly distinctCrates: number;
  readonly indexSizeBytes: number;
  readonly topCrates: readonly KacheTopCrate[];
  readonly priors: KacheIndexPriors;
}

const unavailableIndex: IndexReadResult = {
  available: false,
  entryCount: 0,
  distinctCrates: 0,
  indexSizeBytes: 0,
  topCrates: [],
  priors: emptyIndexPriors,
};

/**
 * The `GROUP BY` over kache `entries` is synchronous (`node:sqlite`), so the
 * snapshot reader only runs it when the index file (or its WAL) changed.
 */
const readIndexAggregate = (indexPath: string): IndexReadResult => {
  let database: DatabaseSync | undefined;
  try {
    const indexSizeBytes = statSync(indexPath).size;
    database = new DatabaseSync(indexPath, { readOnly: true });
    const aggregate = database.prepare(
      `SELECT crate_name, profile, MAX(compile_time_ms) AS compile_time_ms,
              COUNT(*) AS entry_count
       FROM entries
       GROUP BY crate_name, profile`,
    );
    const timings = new Map<string, number>();
    const maximumByCrate = new Map<string, number>();
    const crates = new Set<string>();
    const topCrates: KacheTopCrate[] = [];
    let entryCount = 0;
    for (const row of aggregate.all()) {
      const crateName = String(row.crate_name);
      const profile = String(row.profile);
      const compileTimeMs = finitePositiveMs(Number(row.compile_time_ms));
      entryCount += Number(row.entry_count);
      crates.add(crateName);
      if (compileTimeMs === null) {
        continue;
      }
      timings.set(eventPriorKey(crateName, profile), compileTimeMs);
      maximumByCrate.set(
        crateName,
        Math.max(maximumByCrate.get(crateName) ?? 0, compileTimeMs),
      );
      topCrates.push({ crate: crateName, profile, ms: compileTimeMs });
    }
    topCrates.sort((left, right) => right.ms - left.ms || left.crate.localeCompare(right.crate));
    // Cap within each profile; the flat ms-descending order of the surviving
    // rows is presentation-neutral (consumers group by profile).
    const perProfileSeen = new Map<string, number>();
    const cappedTopCrates = topCrates.filter((row) => {
      const seen = perProfileSeen.get(row.profile) ?? 0;
      perProfileSeen.set(row.profile, seen + 1);
      return seen < topCratesPerProfile;
    });
    return {
      available: true,
      entryCount,
      distinctCrates: crates.size,
      indexSizeBytes,
      topCrates: cappedTopCrates,
      priors: {
        compileTimeMs: (crateName, profiles) => {
          let exact: number | null = null;
          for (const profile of profiles) {
            const timing = timings.get(eventPriorKey(crateName, profile));
            if (timing !== undefined) {
              exact = Math.max(exact ?? 0, timing);
            }
          }
          return exact ?? maximumByCrate.get(crateName) ?? null;
        },
      },
    };
  } catch {
    return unavailableIndex;
  } finally {
    try {
      database?.close();
    } catch {
      // A read-only status refresh must never affect daemon availability.
    }
  }
};

const combineSnapshot = (index: IndexReadResult, events: EventReadResult): KacheStatusSnapshot => ({
  status: {
    available: index.available,
    entryCount: index.entryCount,
    distinctCrates: index.distinctCrates,
    indexSizeBytes: index.indexSizeBytes,
    eventsFreshMs: events.eventsFreshMs,
    recentHeartbeatRoots: events.recentHeartbeatRoots,
    topCrates: index.topCrates,
  },
  indexPriors: index.priors,
  eventPriors: events.priors,
});

/**
 * Identity of the on-disk index: main file plus WAL, because kache commits
 * land in `index.db-wal` long before a checkpoint touches `index.db`.
 */
const indexFingerprint = async (indexPath: string): Promise<string | null> => {
  const describe = async (path: string): Promise<string> => {
    try {
      const stats = await stat(path, { bigint: true });
      return `${stats.ino}:${stats.size}:${stats.mtimeNs}`;
    } catch {
      return 'missing';
    }
  };
  const main = await describe(indexPath);
  if (main === 'missing') {
    return null;
  }
  return `${main}|${await describe(`${indexPath}-wal`)}`;
};

export interface KacheSnapshotReader {
  /** Refreshes from disk without blocking the event loop and returns the snapshot. */
  readonly read: (nowMs: number) => Promise<KacheStatusSnapshot>;
}

export interface CreateKacheSnapshotReaderOptions {
  readonly maxEventBytes?: number;
  /** Milliseconds of line parsing between event-loop yields. */
  readonly parseSliceMs?: number;
}

interface EventsCursor {
  readonly ino: bigint;
  readonly offset: number;
}

/**
 * Stateful reader behind `KacheStatus`. The events sidecar is consumed
 * incrementally from a persisted byte offset with async reads and
 * `setImmediate`-sliced parsing; the index aggregate is recomputed only when
 * the file fingerprint changes. Every failure degrades to "unavailable".
 */
export const createKacheSnapshotReader = (
  indexPath: string,
  options: CreateKacheSnapshotReaderOptions = {},
): KacheSnapshotReader => {
  const eventsPath = join(dirname(indexPath), 'events.jsonl');
  const maxEventBytes =
    options.maxEventBytes !== undefined &&
    Number.isFinite(options.maxEventBytes) &&
    options.maxEventBytes > 0
      ? Math.floor(options.maxEventBytes)
      : defaultEventTailBytes;
  const parseSliceMs = Math.max(0, options.parseSliceMs ?? defaultParseSliceMs);
  const aggregator = new EventTailAggregator();
  let cursor: EventsCursor | undefined;
  let indexCache: { readonly fingerprint: string; readonly result: IndexReadResult } | undefined;

  const ingestText = async (text: string): Promise<void> => {
    let sliceStartedAt = performance.now();
    let lineStart = 0;
    let sinceCheck = 0;
    while (lineStart < text.length) {
      const newline = text.indexOf('\n', lineStart);
      const lineEnd = newline === -1 ? text.length : newline;
      aggregator.ingest(text.slice(lineStart, lineEnd));
      lineStart = lineEnd + 1;
      sinceCheck += 1;
      if (sinceCheck >= parseSliceCheckEvery) {
        sinceCheck = 0;
        if (performance.now() - sliceStartedAt >= parseSliceMs) {
          await yieldToEventLoop();
          sliceStartedAt = performance.now();
        }
      }
    }
  };

  const readEvents = async (nowMs: number): Promise<EventReadResult> => {
    let handle: FileHandle | undefined;
    try {
      handle = await open(eventsPath, 'r');
      const stats = await handle.stat({ bigint: true });
      const size = Number(stats.size);
      const continuing =
        cursor !== undefined &&
        cursor.ino === stats.ino &&
        size >= cursor.offset &&
        size - cursor.offset <= maxEventBytes;
      let skipPartialFirstLine = false;
      let start: number;
      if (continuing && cursor !== undefined) {
        start = cursor.offset;
      } else {
        aggregator.reset();
        start = Math.max(0, size - maxEventBytes);
        skipPartialFirstLine = start > 0;
      }
      const chunk = Buffer.allocUnsafe(Math.min(eventReadChunkBytes, Math.max(1, size - start)));
      let pending: Buffer = Buffer.alloc(0);
      let position = start;
      let consumedTo = start;
      while (position < size) {
        const { bytesRead } = await handle.read(
          chunk,
          0,
          Math.min(chunk.length, size - position),
          position,
        );
        if (bytesRead === 0) {
          break;
        }
        position += bytesRead;
        const data =
          pending.length === 0
            ? chunk.subarray(0, bytesRead)
            : Buffer.concat([pending, chunk.subarray(0, bytesRead)]);
        const lastNewline = data.lastIndexOf(0x0a);
        if (lastNewline === -1) {
          pending = Buffer.from(data);
          continue;
        }
        // Lines are cut at ASCII newlines, so complete lines decode without a
        // streaming decoder; the trailing partial line waits for its newline.
        pending = Buffer.from(data.subarray(lastNewline + 1));
        consumedTo = position - pending.length;
        let text = data.subarray(0, lastNewline + 1).toString('utf8');
        if (skipPartialFirstLine) {
          skipPartialFirstLine = false;
          text = text.slice(text.indexOf('\n') + 1);
        }
        await ingestText(text);
      }
      aggregator.addBytesRead(consumedTo - start);
      cursor = { ino: stats.ino, offset: consumedTo };
      return aggregator.result(nowMs);
    } catch {
      aggregator.reset();
      cursor = undefined;
      return emptyEventReadResult;
    } finally {
      try {
        await handle?.close();
      } catch {
        // Kache status is best-effort; close failures do not affect the daemon.
      }
    }
  };

  const readIndex = async (): Promise<IndexReadResult> => {
    const fingerprint = await indexFingerprint(indexPath);
    if (fingerprint === null) {
      indexCache = undefined;
      return unavailableIndex;
    }
    if (indexCache !== undefined && indexCache.fingerprint === fingerprint) {
      return indexCache.result;
    }
    const result = readIndexAggregate(indexPath);
    indexCache = { fingerprint, result };
    return result;
  };

  const readOnce = async (nowMs: number): Promise<KacheStatusSnapshot> => {
    const events = await readEvents(nowMs);
    const index = await readIndex();
    return combineSnapshot(index, events);
  };

  // The cursor and aggregator are shared state, so overlapping reads are
  // serialized rather than interleaved.
  let inflight: Promise<unknown> = Promise.resolve();
  return {
    read: (nowMs) => {
      const next = inflight.then(() => readOnce(nowMs));
      inflight = next.then(
        () => undefined,
        () => undefined,
      );
      return next;
    },
  };
};

export interface KacheStatusApi {
  readonly current: Effect.Effect<KacheStatusReport | null>;
  readonly priors: Effect.Effect<KachePriorSnapshot>;
}

export class KacheStatus extends Context.Service<KacheStatus, KacheStatusApi>()(
  'cargo-hauler/KacheStatus',
) {}

interface CreateKacheStatusOptions {
  readonly indexPath: string;
  readonly maxEventBytes?: number;
  readonly now?: () => number;
  readonly ttlMs?: number;
}

export const createKacheStatus = (
  options: CreateKacheStatusOptions,
): KacheStatusApi & { readonly prewarm: Effect.Effect<void> } => {
  const now = options.now ?? Date.now;
  const ttlMs = Math.max(0, options.ttlMs ?? defaultTtlMs);
  const reader = createKacheSnapshotReader(options.indexPath, {
    maxEventBytes: options.maxEventBytes,
  });
  let cache:
    | { readonly atMs: number; readonly snapshot: KacheStatusSnapshot }
    | undefined;
  let refreshing = false;

  const refresh = (): Effect.Effect<void> =>
    Effect.suspend(() => {
      if (options.indexPath.length === 0 || refreshing) {
        return Effect.void;
      }
      refreshing = true;
      return Effect.promise(() => reader.read(now())).pipe(
        Effect.tap((snapshot) =>
          Effect.sync(() => {
            cache = { atMs: now(), snapshot };
          }),
        ),
        Effect.asVoid,
        Effect.ensuring(
          Effect.sync(() => {
            refreshing = false;
          }),
        ),
        Effect.ignoreCause,
      );
    });

  const refreshIfStale = Effect.gen(function* () {
    if (options.indexPath.length === 0) {
      return;
    }
    const cached = cache;
    if (cached === undefined || now() - cached.atMs >= ttlMs) {
      yield* Effect.forkDetach(refresh());
    }
  });

  return {
    prewarm: refresh(),
    current: refreshIfStale.pipe(
      Effect.map(() =>
        options.indexPath.length === 0 ? null : (cache?.snapshot.status ?? null),
      ),
    ),
    priors: refreshIfStale.pipe(
      Effect.map(() => ({
        indexPriors: cache?.snapshot.indexPriors ?? emptyIndexPriors,
        eventPriors: cache?.snapshot.eventPriors ?? emptyEventPriors,
      })),
    ),
  };
};

export const KacheStatusLive: Layer.Layer<KacheStatus, never, DaemonConfig> = Layer.effect(
  KacheStatus,
  Effect.gen(function* () {
    const config = yield* DaemonConfig;
    const service = createKacheStatus({ indexPath: config.kacheIndexPath });
    yield* Effect.forkScoped(service.prewarm);
    return service;
  }),
);
