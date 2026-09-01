import { closeSync, fstatSync, openSync, readSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
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
const topCrateLimit = 8;
const eventEwmaAlpha = 0.25;

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

interface EventReadResult {
  readonly priors: KacheEventPriors;
  readonly eventsFreshMs: number | null;
  readonly recentHeartbeatRoots: KacheStatusReport['recentHeartbeatRoots'];
}

const readEventTail = (
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

    const aggregates = new Map<string, EventAggregate>();
    const crates = new Set<string>();
    const heartbeatRoots = new Map<string, number>();
    let latestEventAtMs: number | null = null;
    let sampleCount = 0;
    for (const line of text.split('\n')) {
      if (line.length === 0) {
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (!Predicate.isObject(parsed)) {
        continue;
      }
      const eventAtMs =
        typeof parsed.ts === 'string' && Number.isFinite(Date.parse(parsed.ts))
          ? Date.parse(parsed.ts)
          : null;
      if (eventAtMs !== null) {
        latestEventAtMs = Math.max(latestEventAtMs ?? eventAtMs, eventAtMs);
      }
      if (
        parsed.event === 'heartbeat' &&
        typeof parsed.root === 'string' &&
        parsed.root.length > 0 &&
        eventAtMs !== null &&
        nowMs - eventAtMs >= 0 &&
        nowMs - eventAtMs <= heartbeatWindowMs
      ) {
        heartbeatRoots.set(parsed.root, (heartbeatRoots.get(parsed.root) ?? 0) + 1);
      }
      if (typeof parsed.crate_name !== 'string') {
        continue;
      }
      const crateName = parsed.crate_name;
      if (crateName.length === 0 || crateName === 'unknown') {
        continue;
      }
      const key = eventPriorKey(crateName, eventProfile(parsed));
      const aggregate = aggregates.get(key) ?? {
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
        continue;
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
      aggregates.set(key, aggregate);
      crates.add(crateName);
      sampleCount += 1;
    }

    return {
      eventsFreshMs:
        latestEventAtMs === null ? null : Math.max(0, nowMs - latestEventAtMs),
      recentHeartbeatRoots: [...heartbeatRoots]
        .map(([root, count]) => ({ root, count }))
        .sort((left, right) => right.count - left.count || left.root.localeCompare(right.root)),
      priors: {
        bytesRead,
        crateCount: crates.size,
        sampleCount,
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
  } catch {
    return {
      eventsFreshMs: null,
      recentHeartbeatRoots: [],
      priors: emptyEventPriors,
    };
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
): KacheEventPriors => readEventTail(eventsPath, Date.now(), maxBytes).priors;

const unavailableStatus = (): KacheStatusReport => ({
  available: false,
  entryCount: 0,
  distinctCrates: 0,
  indexSizeBytes: 0,
  eventsFreshMs: null,
  recentHeartbeatRoots: [],
  topCrates: [],
});

export const readKacheStatusSnapshot = (
  indexPath: string,
  options: {
    readonly nowMs?: number;
    readonly maxEventBytes?: number;
  } = {},
): KacheStatusSnapshot => {
  const nowMs = options.nowMs ?? Date.now();
  const events = readEventTail(
    join(dirname(indexPath), 'events.jsonl'),
    nowMs,
    options.maxEventBytes ?? defaultEventTailBytes,
  );
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
    return {
      status: {
        available: true,
        entryCount,
        distinctCrates: crates.size,
        indexSizeBytes,
        eventsFreshMs: events.eventsFreshMs,
        recentHeartbeatRoots: events.recentHeartbeatRoots,
        topCrates: topCrates.slice(0, topCrateLimit),
      },
      indexPriors: {
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
      eventPriors: events.priors,
    };
  } catch {
    return {
      status: unavailableStatus(),
      indexPriors: emptyIndexPriors,
      eventPriors: events.priors,
    };
  } finally {
    try {
      database?.close();
    } catch {
      // A read-only status refresh must never affect daemon availability.
    }
  }
};

export interface KacheStatusApi {
  readonly current: Effect.Effect<KacheStatusReport | null>;
  readonly priors: Effect.Effect<KachePriorSnapshot>;
}

export class KacheStatus extends Context.Service<KacheStatus, KacheStatusApi>()(
  'cargo-conductor/KacheStatus',
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
      return Effect.sync(() =>
        readKacheStatusSnapshot(options.indexPath, {
          maxEventBytes: options.maxEventBytes,
          nowMs: now(),
        }),
      ).pipe(
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
        Effect.catchCause(() => Effect.void),
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
