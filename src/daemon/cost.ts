import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as SynchronizedRef from 'effect/SynchronizedRef';

import { DaemonConfig } from './config.js';
import type { NormalizedCargoIntent } from './intent-normalizer.js';
import { Ledger } from './ledger.js';

export interface CostEstimate {
  readonly estimateMs: number;
  readonly source: 'ewma' | 'kache' | 'default';
}

export interface CostModelApi {
  readonly estimate: (
    intent: NormalizedCargoIntent,
    closurePackages?: ReadonlySet<string> | readonly string[],
  ) => Effect.Effect<CostEstimate>;
  readonly recordOutcome: (intentKey: string, runMs: number) => Effect.Effect<void>;
}

export class CostModel extends Context.Tag('cargo-conductor/CostModel')<
  CostModel,
  CostModelApi
>() {}

/** Cold-start priors per subcommand, from the mined tracedecay p50s. */
const defaultEstimates: Readonly<Record<string, number>> = {
  bench: 600_000,
  build: 300_000,
  check: 120_000,
  clippy: 150_000,
  doc: 180_000,
  fmt: 10_000,
  nextest: 300_000,
  run: 60_000,
  test: 300_000,
};

const fallbackDefaultMs = 60_000;
const workspaceMultiplier = 2;
const ewmaAlpha = 0.4;
const ewmaSeedLimit = 5;
const minimumEstimateMs = 100;
const maximumEstimateMs = 24 * 60 * 60_000;
const defaultEffectiveParallelism = 4;
const defaultEventTailBytes = 8 * 1024 * 1024;
const defaultEventTtlMs = 5 * 60_000;
const defaultIndexTtlMs = 10 * 60_000;
const eventEwmaAlpha = 0.25;
const eventPriorWeight = 0.65;
const observationCacheLimit = 4_096;

const finitePositiveMs = (value: number): number | null =>
  Number.isFinite(value) && value > 0 ? value : null;

const safeEstimateMs = (value: number): number =>
  Math.round(
    Math.min(
      maximumEstimateMs,
      Math.max(minimumEstimateMs, finitePositiveMs(value) ?? minimumEstimateMs),
    ),
  );

export const defaultEstimateFor = (intent: NormalizedCargoIntent): number => {
  const base = defaultEstimates[intent.subcommand] ?? fallbackDefaultMs;
  return intent.workspace || (intent.packages.length === 0 && intent.subcommand !== 'fmt')
    ? base * workspaceMultiplier
    : base;
};

/** Maps cargo profile names onto the artifact-directory names kache records. */
const kacheProfilesFor = (profile: string): readonly string[] => {
  if (profile === 'dev' || profile === 'test') {
    return [profile, 'debug'];
  }
  if (profile === 'bench') {
    return [profile, 'release'];
  }
  return [profile];
};

interface KacheReader {
  readonly load: () => KacheIndexPriors;
  readonly close: () => void;
}

export interface KacheIndexPriors {
  readonly compileTimeMs: (crateName: string, profiles: readonly string[]) => number | null;
}

export interface KacheEventPriors {
  readonly bytesRead: number;
  readonly crateCount: number;
  readonly sampleCount: number;
  readonly compileTimeMs: (crateName: string, profiles: readonly string[]) => number | null;
}

const emptyEventPriors: KacheEventPriors = {
  bytesRead: 0,
  crateCount: 0,
  sampleCount: 0,
  compileTimeMs: () => null,
};

const emptyIndexPriors: KacheIndexPriors = {
  compileTimeMs: () => null,
};

interface EventAggregate {
  compileEwmaMs: number | null;
  heartbeatMaxMs: number | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const eventProfile = (event: Record<string, unknown>): string => {
  if (typeof event.profile === 'string' && event.profile.length > 0) {
    return event.profile;
  }
  if (typeof event.root === 'string') {
    const match = /(?:^|[/\\])target[/\\](debug|release)(?:[/\\]|$)/u.exec(event.root);
    if (match?.[1] !== undefined) {
      return match[1];
    }
  }
  // Current kache schema 15 events often omit profile. Retain those as a
  // profile-agnostic prior rather than pretending they are dev builds.
  return '*';
};

const eventPriorKey = (crateName: string, profile: string): string =>
  `${crateName}\0${profile}`;

/**
 * Reads only the newest bytes of kache's append-only event stream. A partial
 * first record is discarded when the read begins mid-file. Outcome timings
 * use a chronological EWMA; repeated heartbeats contribute only their maximum
 * elapsed lower bound so a long in-progress compile is not overweighted.
 */
export const readKacheEventPriors = (
  eventsPath: string,
  maxBytes = defaultEventTailBytes,
): KacheEventPriors => {
  if (eventsPath.length === 0) {
    return emptyEventPriors;
  }
  const requestedBytes =
    Number.isFinite(maxBytes) && maxBytes > 0 ? Math.floor(maxBytes) : defaultEventTailBytes;
  let fileDescriptor: number | undefined;
  try {
    fileDescriptor = openSync(eventsPath, 'r');
    const fileBytes = fstatSync(fileDescriptor).size;
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
      if (!isRecord(parsed) || typeof parsed.crate_name !== 'string') {
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
    };
  } catch {
    return emptyEventPriors;
  } finally {
    if (fileDescriptor !== undefined) {
      try {
        closeSync(fileDescriptor);
      } catch {
        // Event priors are best-effort; close failures do not affect estimates.
      }
    }
  }
};

/**
 * Read-only view over kache's index.db (per-crate compile_time_ms priors).
 * Every failure — missing file, busy database, schema drift — degrades to
 * "no prior" rather than an error.
 */
export const openKacheReader = (indexPath: string): KacheReader | null => {
  if (indexPath.length === 0) {
    return null;
  }
  let db: DatabaseSync | undefined;
  let aggregate: ReturnType<DatabaseSync['prepare']>;
  try {
    db = new DatabaseSync(indexPath, { readOnly: true });
    db.prepare('SELECT compile_time_ms FROM entries LIMIT 1').get();
    aggregate = db.prepare(
      `SELECT crate_name, profile, MAX(compile_time_ms) AS compile_time_ms
       FROM entries
       GROUP BY crate_name, profile`,
    );
  } catch {
    try {
      db?.close();
    } catch {
      // A failed schema probe still degrades to no prior.
    }
    return null;
  }
  const readerDb = db;
  return {
    close: () => {
      readerDb.close();
    },
    load: () => {
      const timings = new Map<string, number>();
      const maximumByCrate = new Map<string, number>();
      for (const row of aggregate.all()) {
        const crateName = String(row.crate_name);
        const profile = String(row.profile);
        const compileTimeMs = finitePositiveMs(Number(row.compile_time_ms));
        if (compileTimeMs === null) {
          continue;
        }
        timings.set(eventPriorKey(crateName, profile), compileTimeMs);
        maximumByCrate.set(
          crateName,
          Math.max(maximumByCrate.get(crateName) ?? 0, compileTimeMs),
        );
      }
      return {
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
      };
    },
  };
};

const kacheEstimate = (
  indexPriors: KacheIndexPriors,
  eventPriors: KacheEventPriors,
  crateName: string,
  profiles: readonly string[],
): number | null => {
  const indexValue = indexPriors.compileTimeMs(crateName, profiles);
  const indexMs = indexValue === null ? null : finitePositiveMs(indexValue);
  const eventValue = eventPriors.compileTimeMs(crateName, profiles);
  const eventMs = eventValue === null ? null : finitePositiveMs(eventValue);
  if (indexMs !== null && eventMs !== null) {
    return eventPriorWeight * eventMs + (1 - eventPriorWeight) * indexMs;
  }
  return eventMs ?? indexMs;
};

export interface EventPriorCacheOptions {
  readonly initial?: KacheEventPriors;
  readonly load: () => Effect.Effect<KacheEventPriors, unknown>;
  readonly ttlMs?: number;
}

export interface KachePriorCacheOptions {
  readonly initial?: KacheIndexPriors;
  readonly ttlMs?: number;
}

export interface CreateCostModelOptions {
  readonly effectiveParallelism?: number;
  readonly eventPriors?: EventPriorCacheOptions;
  readonly kachePriors?: KachePriorCacheOptions;
  readonly kacheReader: KacheReader | null;
  readonly now?: () => number;
  readonly seedDurations: (intentKey: string, limit: number) => Effect.Effect<readonly number[]>;
}

const subcommandClass = (subcommand: string): string => {
  if (subcommand === 'check' || subcommand === 'clippy') {
    return 'check';
  }
  if (subcommand === 'build' || subcommand === 'run') {
    return 'build';
  }
  if (subcommand === 'bench' || subcommand === 'nextest' || subcommand === 'test') {
    return 'test';
  }
  return subcommand;
};

const crateObservationKey = (
  crateName: string,
  profile: string,
  commandClass: string,
): string => `${crateName}\0${profile}\0${commandClass}`;

const configuredParallelism = (): number => {
  const parsed = Number.parseInt(process.env.CARGO_BUILD_JOBS ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : defaultEffectiveParallelism;
};

interface IntentObservationContext {
  readonly crateKeys: readonly string[];
  readonly parallelism: number;
}

interface CostModelWithPrewarm extends CostModelApi {
  readonly prewarmIndexPriors: Effect.Effect<void>;
}

const lruSet = <K, V>(
  current: ReadonlyMap<K, V>,
  key: K,
  value: V,
): ReadonlyMap<K, V> => {
  const updated = new Map(current);
  updated.delete(key);
  updated.set(key, value);
  while (updated.size > observationCacheLimit) {
    const oldest = updated.keys().next().value as K | undefined;
    if (oldest === undefined) {
      break;
    }
    updated.delete(oldest);
  }
  return updated;
};

const lruSetMutable = <K, V>(map: Map<K, V>, key: K, value: V): void => {
  map.delete(key);
  map.set(key, value);
  while (map.size > observationCacheLimit) {
    const oldest = map.keys().next().value as K | undefined;
    if (oldest === undefined) {
      break;
    }
    map.delete(oldest);
  }
};

export const createCostModel = (options: CreateCostModelOptions): CostModelWithPrewarm => {
  /** intentKey -> EWMA of observed run durations; null marks "seeded, empty". */
  const ewma = SynchronizedRef.unsafeMake<ReadonlyMap<string, number | null>>(new Map());
  const crateObservations = new Map<string, number>();
  const intentContexts = new Map<string, IntentObservationContext>();
  const now = options.now ?? Date.now;
  const suppliedParallelism = options.effectiveParallelism ?? configuredParallelism();
  const parallelism =
    Number.isFinite(suppliedParallelism) && suppliedParallelism > 0
      ? Math.max(1, Math.floor(suppliedParallelism))
      : defaultEffectiveParallelism;
  const eventTtlMs = Math.max(0, options.eventPriors?.ttlMs ?? defaultEventTtlMs);
  let eventCache =
    options.eventPriors?.initial === undefined
      ? undefined
      : { atMs: now(), priors: options.eventPriors.initial };
  let refreshingEvents = false;
  const indexTtlMs = Math.max(0, options.kachePriors?.ttlMs ?? defaultIndexTtlMs);
  let indexCache =
    options.kachePriors?.initial === undefined
      ? undefined
      : { atMs: now(), priors: options.kachePriors.initial };
  let refreshingIndex = false;

  const seededEwma = (intentKey: string): Effect.Effect<number | null> =>
    SynchronizedRef.modifyEffect(ewma, (current) => {
      if (current.has(intentKey)) {
        const value = current.get(intentKey) ?? null;
        return Effect.succeed([value, lruSet(current, intentKey, value)] as const);
      }
      return options.seedDurations(intentKey, ewmaSeedLimit).pipe(
        Effect.catchAllCause(() => Effect.succeed([])),
        Effect.map((durations) => {
          let value: number | null = null;
          // Seed oldest-first so the newest observation weighs the most.
          for (const runMs of [...durations].reverse()) {
            const validRunMs = finitePositiveMs(runMs);
            if (validRunMs !== null) {
              value =
                value === null ? validRunMs : value + ewmaAlpha * (validRunMs - value);
            }
          }
          return [value, lruSet(current, intentKey, value)] as const;
        }),
      );
    });

  const refreshIndexPriors = (): Effect.Effect<void> =>
    Effect.suspend(() => {
      if (options.kacheReader === null || refreshingIndex) {
        return Effect.void;
      }
      refreshingIndex = true;
      return Effect.sync(() => options.kacheReader?.load() ?? emptyIndexPriors).pipe(
        Effect.tap((priors) =>
          Effect.sync(() => {
            indexCache = { atMs: now(), priors };
          }),
        ),
        Effect.asVoid,
        Effect.ensuring(
          Effect.sync(() => {
            refreshingIndex = false;
          }),
        ),
        Effect.catchAllCause(() => Effect.void),
      );
    });

  const currentIndexPriors = (): Effect.Effect<KacheIndexPriors> =>
    Effect.gen(function* () {
      const cached = indexCache;
      const fresh = cached !== undefined && now() - cached.atMs < indexTtlMs;
      if (!fresh) {
        yield* Effect.forkDaemon(refreshIndexPriors());
      }
      return cached?.priors ?? emptyIndexPriors;
    });

  const currentEventPriors = (): Effect.Effect<KacheEventPriors> =>
    Effect.gen(function* () {
      const eventOptions = options.eventPriors;
      if (eventOptions === undefined) {
        return emptyEventPriors;
      }
      const cached = eventCache;
      const fresh = cached !== undefined && now() - cached.atMs < eventTtlMs;
      if (!fresh && !refreshingEvents) {
        refreshingEvents = true;
        const refresh = eventOptions.load().pipe(
          Effect.tap((priors) =>
            Effect.sync(() => {
              eventCache = { atMs: now(), priors };
            }),
          ),
          Effect.asVoid,
          Effect.ensuring(
            Effect.sync(() => {
              refreshingEvents = false;
            }),
          ),
          Effect.catchAllCause(() => Effect.void),
        );
        yield* Effect.forkDaemon(refresh);
      }
      return cached?.priors ?? emptyEventPriors;
    });

  return {
    prewarmIndexPriors: Effect.gen(function* () {
      const cached = indexCache;
      if (cached === undefined || now() - cached.atMs >= indexTtlMs) {
        yield* refreshIndexPriors();
      }
    }),
    estimate: (intent, closurePackages = []) =>
      Effect.gen(function* () {
        const packageNames = [
          ...new Set<string>([...intent.packages, ...closurePackages]),
        ];
        const commandClass = subcommandClass(intent.subcommand);
        const crates = packageNames.map((crateName) => ({
          crateName,
          observationKey: crateObservationKey(crateName, intent.profile, commandClass),
        }));
        lruSetMutable(intentContexts, intent.key, {
          crateKeys: crates.map(({ observationKey }) => observationKey),
          parallelism,
        });

        const observed = yield* seededEwma(intent.key);
        if (observed !== null) {
          return { estimateMs: safeEstimateMs(observed), source: 'ewma' as const };
        }
        if (packageNames.length === 0) {
          return {
            estimateMs: safeEstimateMs(defaultEstimateFor(intent)),
            source: 'default' as const,
          };
        }
        const events = yield* currentEventPriors();
        const indexPriors = yield* currentIndexPriors();
        const profiles = kacheProfilesFor(intent.profile);
        const fallback = defaultEstimateFor(intent);
        let hasCrateObservation = false;
        let hasKachePrior = false;
        let maximum = 0;
        let total = 0;
        for (const { crateName, observationKey } of crates) {
          const crateObserved = crateObservations.get(observationKey) ?? null;
          const prior =
            crateObserved === null
              ? kacheEstimate(indexPriors, events, crateName, profiles)
              : null;
          const crateMs = crateObserved ?? prior ?? fallback;
          hasCrateObservation ||= crateObserved !== null;
          hasKachePrior ||= prior !== null;
          maximum = Math.max(maximum, crateMs);
          total += crateMs;
        }
        /**
         * Cargo schedules independent crates concurrently. The largest crate
         * approximates a minimum critical path, while total work divided by
         * the cargo worker grant bounds throughput. Taking their maximum is
         * conservative without incorrectly summing fully parallel work.
         */
        const estimateMs = safeEstimateMs(Math.max(maximum, total / parallelism));
        const source = hasCrateObservation
          ? ('ewma' as const)
          : hasKachePrior
            ? ('kache' as const)
            : ('default' as const);
        return { estimateMs, source };
      }),
    recordOutcome: (intentKey, runMs) =>
      Effect.gen(function* () {
        const validRunMs = finitePositiveMs(runMs);
        if (validRunMs === null) {
          return;
        }
        yield* SynchronizedRef.update(ewma, (current) => {
          const observed = current.get(intentKey);
          const base = observed === undefined || observed === null ? validRunMs : observed;
          return lruSet(
            current,
            intentKey,
            base + ewmaAlpha * (validRunMs - base),
          );
        });
        const context = intentContexts.get(intentKey);
        if (context === undefined || context.crateKeys.length === 0) {
          return;
        }
        // Invert the same parallelism model used by estimate(): if N crates
        // produced this wall time, store the equal-work per-crate equivalent.
        const workFactor = Math.max(1, context.crateKeys.length / context.parallelism);
        const sampleMs = validRunMs / workFactor;
        for (const key of context.crateKeys) {
          const previous = crateObservations.get(key) ?? null;
          crateObservations.set(
            key,
            previous === null ? sampleMs : previous + ewmaAlpha * (sampleMs - previous),
          );
        }
      }),
  };
};

export const CostModelLive: Layer.Layer<CostModel, never, DaemonConfig | Ledger> = Layer.scoped(
  CostModel,
  Effect.gen(function* () {
    const config = yield* DaemonConfig;
    const ledger = yield* Ledger;
    const kacheReader = yield* Effect.acquireRelease(
      Effect.sync(() => openKacheReader(config.kacheIndexPath)),
      (reader) =>
        reader === null
          ? Effect.void
          : Effect.sync(() => {
              reader.close();
            }),
    );
    const model = createCostModel({
      effectiveParallelism: config.jobsGrant > 0 ? config.jobsGrant : configuredParallelism(),
      eventPriors:
        config.kacheIndexPath.length === 0
          ? undefined
          : {
              load: () =>
                Effect.sync(() =>
                  readKacheEventPriors(join(dirname(config.kacheIndexPath), 'events.jsonl')),
                ),
            },
      kacheReader,
      seedDurations: (intentKey, limit) => ledger.recentDurations(intentKey, limit),
    });
    yield* Effect.forkScoped(model.prewarmIndexPriors);
    return model;
  }),
);
