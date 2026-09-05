import { DatabaseSync } from 'node:sqlite';

import '../lib/quiet-sqlite-warning.js';

import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as SynchronizedRef from 'effect/SynchronizedRef';

import { executionSubcommands } from './build-phase.js';
import { DaemonConfig } from './config.js';
import type { NormalizedCargoIntent } from './intent-normalizer.js';
import {
  emptyEventPriors,
  emptyIndexPriors,
  eventPriorKey,
  finitePositiveMs,
  KacheStatus,
} from './kache-status.js';
import type {
  KacheEventPriors,
  KacheIndexPriors,
  KachePriorSnapshot,
} from './kache-status.js';
import { Ledger } from './ledger.js';
import type { NeighborDurationQuery, PhaseDurationSample } from './ledger.js';
import type { EstimateSource, KacheStatusReport } from './protocol.js';

export { readKacheEventPriors } from './kache-status.js';
export type { KacheEventPriors, KacheIndexPriors } from './kache-status.js';

export interface CostEstimate {
  readonly estimateMs: number;
  readonly source: EstimateSource;
  /** Present when compile and execute were estimated separately. */
  readonly compileEstimateMs?: number;
  /** Present for test/nextest/bench/run when execution history exists. */
  readonly executeEstimateMs?: number;
}

export interface RecordOutcomeOptions {
  /**
   * `failed` runs (a compile error seconds in) still time this exact intent —
   * a retry must not be re-estimated cold — but say nothing about how long
   * the crates take to build once they compile, so they never feed the
   * per-crate priors shared with other intents. Default `done`.
   */
  readonly outcome?: 'done' | 'failed';
  /**
   * Whether the run's packages had been edited within the topology's edit
   * window when it was submitted. Runs are timed per mode: an edit forces a
   * rebuild, an unedited rerun is mostly cached, and one blended average
   * would send the next rebuild to the head of the lane on a seconds-long
   * estimate. Unknown (undefined) teaches both modes. Unedited runs never
   * feed the per-crate compile priors either: their wall time is cache
   * no-ops, not compile cost.
   */
  readonly editedRecently?: boolean;
  /** Compile-phase wall time (started → build-finished), when the split exists. */
  readonly compileMs?: number;
  /** Execution-phase wall time (build-finished → exit), when the split exists. */
  readonly executeMs?: number;
}

export interface EstimateOptions {
  /** Selects the timing mode; see {@link RecordOutcomeOptions.editedRecently}. */
  readonly editedRecently?: boolean;
}

export interface CostModelApi {
  readonly estimate: (
    intent: NormalizedCargoIntent,
    closurePackages?: ReadonlySet<string> | readonly string[],
    options?: EstimateOptions,
  ) => Effect.Effect<CostEstimate>;
  readonly kacheStatus: Effect.Effect<KacheStatusReport | null>;
  readonly recordOutcome: (
    intentKey: string,
    runMs: number,
    options?: RecordOutcomeOptions,
  ) => Effect.Effect<void>;
  /** Newest-first whole-run p90 for an intent; null when history is empty. */
  readonly intentP90Ms: (intentKey: string) => Effect.Effect<number | null>;
}

export class CostModel extends Context.Service<CostModel, CostModelApi>()(
  'cargo-hauler/CostModel',
) {}

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
const p90SampleLimit = 50;
const p90CacheTtlMs = 5_000;
const minimumEstimateMs = 100;
const maximumEstimateMs = 24 * 60 * 60_000;
const defaultEffectiveParallelism = 4;
const defaultEventTtlMs = 5 * 60_000;
const defaultIndexTtlMs = 10 * 60_000;
const eventPriorWeight = 0.65;
const observationCacheLimit = 4_096;

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

/**
 * Maps cargo profiles onto the artifact-directory names kache records.
 * Custom profiles overwhelmingly inherit Cargo's release profile, so prefer
 * their exact timing and then release before the reader falls back to the
 * crate-wide maximum (which can come from an unrelated debug/test build).
 */
const kacheProfilesFor = (profile: string): readonly string[] => {
  if (profile === 'dev' || profile === 'test') {
    return [profile, 'debug'];
  }
  if (profile === 'bench') {
    return [profile, 'release'];
  }
  return profile === 'release' ? [profile] : [profile, 'release'];
};

interface KacheReader {
  readonly load: () => KacheIndexPriors;
  readonly close: () => void;
}

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
      try {
        readerDb.close();
      } catch {
        // Closing an already-broken or already-closed handle must not throw.
      }
    },
    load: () => {
      // The index can be truncated or replaced after a successful open
      // (kache re-initializing its store); the prepared statement then
      // throws at read time, which must degrade to "no prior".
      let rows: ReturnType<typeof aggregate.all>;
      try {
        rows = aggregate.all();
      } catch {
        return emptyIndexPriors;
      }
      const timings = new Map<string, number>();
      const maximumByCrate = new Map<string, number>();
      for (const row of rows) {
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
  readonly kacheSnapshot?: Effect.Effect<KachePriorSnapshot>;
  readonly kacheStatus?: Effect.Effect<KacheStatusReport | null>;
  readonly kachePriors?: KachePriorCacheOptions;
  readonly kacheReader: KacheReader | null;
  readonly now?: () => number;
  readonly seedDurations: (intentKey: string, limit: number) => Effect.Effect<readonly number[]>;
  readonly seedPhaseDurations?: (
    intentKey: string,
    limit: number,
  ) => Effect.Effect<readonly PhaseDurationSample[]>;
  readonly seedNeighborDurations?: (
    input: NeighborDurationQuery,
  ) => Effect.Effect<readonly number[]>;
}

/**
 * A `--test <name>` (or `--bench`) selection of a single integration-test
 * binary on a single package. The intent key already includes that target;
 * this helper is the neighbor-lookup key when the exact intent has no rows.
 */
export const singleIntegrationTestTarget = (intent: NormalizedCargoIntent): string | null => {
  if (!executionSubcommands.has(intent.subcommand) || intent.packages.length !== 1) {
    return null;
  }
  const named = intent.targets.filter(
    (target) => target.startsWith('test:') || target.startsWith('bench:'),
  );
  return named.length === 1 ? (named[0] ?? null) : null;
};

/** Nearest-rank percentile of positive finite samples; null when none are usable. */
export const durationPercentile = (
  samples: readonly number[],
  percentile: number,
): number | null => {
  const valid = samples
    .map((value) => finitePositiveMs(value))
    .filter((value): value is number => value !== null)
    .sort((left, right) => left - right);
  if (valid.length === 0) {
    return null;
  }
  const clamped = Math.min(100, Math.max(0, percentile));
  const rank = Math.min(valid.length - 1, Math.max(0, Math.ceil((clamped / 100) * valid.length) - 1));
  return valid[rank] ?? null;
};

export interface OverrunAssessment {
  readonly overrun: boolean;
  readonly remainingMs: number;
  /** The intent-history p90 the re-estimate rests on; null when the intent has no finished runs. */
  readonly p90Ms: number | null;
}

/**
 * A head past `stallFactor` × estimate that is still alive (not stalled) is
 * re-estimated from its own p90 instead of contributing zero remaining time.
 * Past the p90 as well — or with no history at all — nothing predicts the
 * end, so one more estimate's worth is the floor: a follower's ETA must not
 * read "any moment now" for the rest of a 10x overrun (#91).
 */
export const assessOverrun = (input: {
  readonly elapsedMs: number;
  readonly estimateMs: number;
  readonly stallFactor: number;
  readonly stalled: boolean;
  readonly p90Ms: number | null;
}): OverrunAssessment => {
  const estimateMs = safeEstimateMs(input.estimateMs);
  const elapsedMs = Math.max(0, input.elapsedMs);
  const remainingMs = Math.max(0, estimateMs - elapsedMs);
  if (input.stalled || elapsedMs <= input.stallFactor * estimateMs) {
    return { overrun: false, remainingMs, p90Ms: input.p90Ms };
  }
  const p90Ms = input.p90Ms === null ? null : safeEstimateMs(input.p90Ms);
  return {
    overrun: true,
    remainingMs: Math.max(estimateMs, (p90Ms ?? 0) - elapsedMs),
    p90Ms,
  };
};

export interface LaneWaitInput {
  readonly startedAtMs: number | null;
  readonly buildFinishedAtMs: number | null;
  readonly estimateMs: number;
  readonly compileEstimateMs: number;
  readonly executeEstimateMs: number | null;
  readonly atMs: number;
  readonly overlapExecution: boolean;
  readonly stalled: boolean;
  readonly stallFactor: number;
  readonly p90Ms: number | null;
}

/**
 * Lane time a job still owes a follower's `queue.waitEtaMs`. A queued job
 * owes its whole estimate — only its compile when overlap will hand the lane
 * back at the build-finished line. An executing head contributes only
 * remaining execute time — or 0 once overlap has handed the lane back. A
 * compiling head contributes remaining compile plus (when overlap is off)
 * execute. An overrun-but-alive head uses p90 remaining instead of zero.
 */
export const laneWaitRemainingMs = (input: LaneWaitInput): number => {
  if (input.startedAtMs === null) {
    return Math.max(
      0,
      input.overlapExecution && input.executeEstimateMs !== null
        ? input.compileEstimateMs
        : input.estimateMs,
    );
  }
  const elapsedMs = Math.max(0, input.atMs - input.startedAtMs);
  const executing = input.buildFinishedAtMs !== null;
  if (executing && input.overlapExecution) {
    return 0;
  }
  const overrun = assessOverrun({
    elapsedMs,
    estimateMs: input.estimateMs,
    p90Ms: input.p90Ms,
    stallFactor: input.stallFactor,
    stalled: input.stalled,
  });
  if (overrun.overrun) {
    return overrun.remainingMs;
  }
  if (executing) {
    if (input.executeEstimateMs !== null && input.buildFinishedAtMs !== null) {
      return Math.max(0, input.executeEstimateMs - Math.max(0, input.atMs - input.buildFinishedAtMs));
    }
    return Math.max(0, input.estimateMs - elapsedMs);
  }
  const remainingCompile = Math.max(0, input.compileEstimateMs - elapsedMs);
  const remainingExecute = input.overlapExecution ? 0 : (input.executeEstimateMs ?? 0);
  return remainingCompile + remainingExecute;
};

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

/** Whole-intent run-time averages, split by whether the packages were freshly edited. */
interface IntentEwma {
  readonly clean: number | null;
  readonly edited: number | null;
}

const emptyIntentEwma: IntentEwma = { clean: null, edited: null };

interface PhaseEwma {
  readonly compile: IntentEwma;
  readonly execute: number | null;
}

const emptyPhaseEwma: PhaseEwma = { compile: emptyIntentEwma, execute: null };

const blendEwma = (base: number | null, sample: number): number =>
  base === null ? sample : base + ewmaAlpha * (sample - base);

/** The mode's own average, else the other mode's — closer than a cold prior. */
const observedRunMs = (observed: IntentEwma, edited: boolean): number | null =>
  edited ? (observed.edited ?? observed.clean) : (observed.clean ?? observed.edited);

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
  /** intentKey -> per-mode EWMA of observed run durations (a seeded entry may hold nulls). */
  const ewma = SynchronizedRef.makeUnsafe<ReadonlyMap<string, IntentEwma>>(new Map());
  const phaseEwma = SynchronizedRef.makeUnsafe<ReadonlyMap<string, PhaseEwma>>(new Map());
  const p90Cache = new Map<string, { readonly atMs: number; readonly value: number | null }>();
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

  const seededEwma = (intentKey: string): Effect.Effect<IntentEwma> =>
    SynchronizedRef.modifyEffect(ewma, (current) => {
      const existing = current.get(intentKey);
      if (existing !== undefined) {
        return Effect.succeed([existing, lruSet(current, intentKey, existing)] as const);
      }
      return options.seedDurations(intentKey, ewmaSeedLimit).pipe(
        Effect.catchCause(() => Effect.succeed([])),
        Effect.map((durations) => {
          let value: number | null = null;
          // Seed oldest-first so the newest observation weighs the most.
          for (const runMs of [...durations].reverse()) {
            const validRunMs = finitePositiveMs(runMs);
            if (validRunMs !== null) {
              value = blendEwma(value, validRunMs);
            }
          }
          // Ledger history predates the mode split and is dominated by cached
          // reruns, so it seeds the cached mode only: the first edited
          // estimate then floors at the crate compile priors instead of
          // inheriting a seconds-long average for a rebuild.
          const seeded: IntentEwma = { clean: value, edited: null };
          return [seeded, lruSet(current, intentKey, seeded)] as const;
        }),
      );
    });

  const seededPhaseEwma = (intentKey: string): Effect.Effect<PhaseEwma> =>
    SynchronizedRef.modifyEffect(phaseEwma, (current) => {
      const existing = current.get(intentKey);
      if (existing !== undefined) {
        return Effect.succeed([existing, lruSet(current, intentKey, existing)] as const);
      }
      const seed = options.seedPhaseDurations;
      if (seed === undefined) {
        return Effect.succeed([emptyPhaseEwma, lruSet(current, intentKey, emptyPhaseEwma)] as const);
      }
      return seed(intentKey, ewmaSeedLimit).pipe(
        Effect.catchCause(() => Effect.succeed([])),
        Effect.map((samples) => {
          let compile: number | null = null;
          let execute: number | null = null;
          for (const sample of [...samples].reverse()) {
            const compileMs = finitePositiveMs(sample.compileMs);
            const executeMs = finitePositiveMs(sample.executeMs);
            if (compileMs !== null) {
              compile = blendEwma(compile, compileMs);
            }
            if (executeMs !== null) {
              execute = blendEwma(execute, executeMs);
            }
          }
          const seeded: PhaseEwma = { compile: { clean: compile, edited: null }, execute };
          return [seeded, lruSet(current, intentKey, seeded)] as const;
        }),
      );
    });

  const seedNeighborIfEmpty = (intent: NormalizedCargoIntent): Effect.Effect<IntentEwma | null> => {
    const target = singleIntegrationTestTarget(intent);
    const seed = options.seedNeighborDurations;
    const packageName = intent.packages[0];
    if (target === null || seed === undefined || packageName === undefined) {
      return Effect.succeed(null);
    }
    return SynchronizedRef.modifyEffect(ewma, (current) => {
      const existing = current.get(intent.key);
      if (existing !== undefined && (existing.clean !== null || existing.edited !== null)) {
        return Effect.succeed([null, current] as const);
      }
      return seed({
        excludeIntentKey: intent.key,
        limit: ewmaSeedLimit,
        packageName,
        testTarget: target,
      }).pipe(
        Effect.catchCause(() => Effect.succeed([])),
        Effect.map((durations) => {
          let value: number | null = null;
          for (const runMs of [...durations].reverse()) {
            const validRunMs = finitePositiveMs(runMs);
            if (validRunMs !== null) {
              value = blendEwma(value, validRunMs);
            }
          }
          if (value === null) {
            return [null, current] as const;
          }
          // Same-package `--test <name>` neighbor, not the crate-wide prior.
          const seeded: IntentEwma = { clean: value, edited: null };
          return [seeded, lruSet(current, intent.key, seeded)] as const;
        }),
      );
    });
  };

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
        Effect.ignoreCause,
      );
    });

  const currentIndexPriors = (): Effect.Effect<KacheIndexPriors> =>
    Effect.gen(function* () {
      const cached = indexCache;
      const fresh = cached !== undefined && now() - cached.atMs < indexTtlMs;
      if (!fresh) {
        yield* Effect.forkDetach(refreshIndexPriors());
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
          Effect.ignoreCause,
        );
        yield* Effect.forkDetach(refresh);
      }
      return cached?.priors ?? emptyEventPriors;
    });

  return {
    kacheStatus: options.kacheStatus ?? Effect.succeed(null),
    prewarmIndexPriors: Effect.gen(function* () {
      const cached = indexCache;
      if (cached === undefined || now() - cached.atMs >= indexTtlMs) {
        yield* refreshIndexPriors();
      }
    }),
    estimate: (intent, closurePackages = [], estimateOptions = {}) =>
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

        const edited = estimateOptions.editedRecently === true;
        let observed = yield* seededEwma(intent.key);
        // A `--test <name>` intent with no rows of its own borrows a
        // same-package neighbor that selected that target. If none exists,
        // the crate-wide kache prior (or the subcommand default) is the
        // fallback — we do not invent a compile time from a different binary.
        if (observed.clean === null && observed.edited === null) {
          observed = (yield* seedNeighborIfEmpty(intent)) ?? observed;
        }
        const phases = yield* seededPhaseEwma(intent.key);
        const ownRunMs = observedRunMs(observed, edited);
        const ownCompileMs = observedRunMs(phases.compile, edited);
        const executeMs = phases.execute;
        // An intent's own mode predicts it best. An edited intent that has
        // only ever been timed cached falls through instead, to floor that
        // average at the crate compile priors: the rebuild the edit forces
        // is exactly what those measure.
        const needsCompileFloor =
          edited &&
          observed.edited === null &&
          phases.compile.edited === null &&
          packageNames.length > 0;

        const crateFloor = Effect.gen(function* () {
          if (packageNames.length === 0) {
            return {
              crateEstimateMs: defaultEstimateFor(intent),
              hasCrateObservation: false,
              hasKachePrior: false,
            };
          }
          const sharedKache =
            options.kacheSnapshot === undefined ? null : yield* options.kacheSnapshot;
          const events =
            sharedKache === null ? yield* currentEventPriors() : sharedKache.eventPriors;
          const indexPriors =
            sharedKache === null ? yield* currentIndexPriors() : sharedKache.indexPriors;
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
          return {
            crateEstimateMs: Math.max(maximum, total / parallelism),
            hasCrateObservation,
            hasKachePrior,
          };
        });

        if (
          executionSubcommands.has(intent.subcommand) &&
          executeMs !== null &&
          (ownCompileMs !== null || needsCompileFloor || packageNames.length > 0)
        ) {
          // Without a compile-phase average of its own, the whole-run average
          // less the execute phase is the compile evidence; never the whole
          // run, which would count execution twice.
          const compileBase =
            ownCompileMs ??
            (ownRunMs === null ? null : Math.max(minimumEstimateMs, ownRunMs - executeMs));
          if (compileBase !== null && !needsCompileFloor) {
            return {
              compileEstimateMs: safeEstimateMs(compileBase),
              estimateMs: safeEstimateMs(compileBase + executeMs),
              executeEstimateMs: safeEstimateMs(executeMs),
              source: 'ewma' as const,
            };
          }
          const floor = yield* crateFloor;
          const compileMs =
            compileBase !== null
              ? floor.hasCrateObservation || floor.hasKachePrior
                ? Math.max(compileBase, floor.crateEstimateMs)
                : compileBase
              : floor.crateEstimateMs;
          const source =
            compileBase !== null
              ? ('ewma' as const)
              : floor.hasCrateObservation
                ? ('ewma' as const)
                : floor.hasKachePrior
                  ? ('kache' as const)
                  : ('ewma' as const);
          return {
            compileEstimateMs: safeEstimateMs(compileMs),
            estimateMs: safeEstimateMs(compileMs + executeMs),
            executeEstimateMs: safeEstimateMs(executeMs),
            source,
          };
        }

        if (ownRunMs !== null && !needsCompileFloor) {
          return { estimateMs: safeEstimateMs(ownRunMs), source: 'ewma' as const };
        }
        if (packageNames.length === 0) {
          return {
            estimateMs: safeEstimateMs(defaultEstimateFor(intent)),
            source: 'default' as const,
          };
        }
        const floor = yield* crateFloor;
        if (ownRunMs !== null) {
          // Only a real prior may raise the estimate: the cold default is
          // no evidence that this intent compiles for minutes.
          const floored =
            floor.hasCrateObservation || floor.hasKachePrior
              ? Math.max(ownRunMs, floor.crateEstimateMs)
              : ownRunMs;
          return { estimateMs: safeEstimateMs(floored), source: 'ewma' as const };
        }
        const estimateMs = safeEstimateMs(floor.crateEstimateMs);
        const source = floor.hasCrateObservation
          ? ('ewma' as const)
          : floor.hasKachePrior
            ? ('kache' as const)
            : ('default' as const);
        return { estimateMs, source };
      }),
    intentP90Ms: (intentKey) =>
      Effect.gen(function* () {
        const cached = p90Cache.get(intentKey);
        if (cached !== undefined && now() - cached.atMs < p90CacheTtlMs) {
          return cached.value;
        }
        const durations = yield* options.seedDurations(intentKey, p90SampleLimit).pipe(
          Effect.catchCause(() => Effect.succeed([])),
        );
        const value = durationPercentile(durations, 90);
        lruSetMutable(p90Cache, intentKey, { atMs: now(), value });
        return value;
      }),
    recordOutcome: (intentKey, runMs, recordOptions) =>
      Effect.gen(function* () {
        const validRunMs = finitePositiveMs(runMs);
        if (validRunMs === null) {
          return;
        }
        p90Cache.delete(intentKey);
        const edited = recordOptions?.editedRecently;
        yield* SynchronizedRef.update(ewma, (current) => {
          const observed = current.get(intentKey) ?? emptyIntentEwma;
          const next: IntentEwma =
            edited === undefined
              ? {
                  clean: blendEwma(observed.clean, validRunMs),
                  edited: blendEwma(observed.edited, validRunMs),
                }
              : edited
                ? { ...observed, edited: blendEwma(observed.edited, validRunMs) }
                : { ...observed, clean: blendEwma(observed.clean, validRunMs) };
          return lruSet(current, intentKey, next);
        });
        const compileMs = finitePositiveMs(recordOptions?.compileMs ?? Number.NaN);
        const executeMs = finitePositiveMs(recordOptions?.executeMs ?? Number.NaN);
        if (compileMs !== null || executeMs !== null) {
          yield* SynchronizedRef.update(phaseEwma, (current) => {
            const observed = current.get(intentKey) ?? emptyPhaseEwma;
            const nextCompile: IntentEwma =
              compileMs === null
                ? observed.compile
                : edited === undefined
                  ? {
                      clean: blendEwma(observed.compile.clean, compileMs),
                      edited: blendEwma(observed.compile.edited, compileMs),
                    }
                  : edited
                    ? { ...observed.compile, edited: blendEwma(observed.compile.edited, compileMs) }
                    : { ...observed.compile, clean: blendEwma(observed.compile.clean, compileMs) };
            const nextExecute =
              executeMs === null ? observed.execute : blendEwma(observed.execute, executeMs);
            return lruSet(current, intentKey, { compile: nextCompile, execute: nextExecute });
          });
        }
        const context = intentContexts.get(intentKey);
        if (
          recordOptions?.outcome === 'failed' ||
          edited === false ||
          context === undefined ||
          context.crateKeys.length === 0
        ) {
          return;
        }
        // Invert the same parallelism model used by estimate(): if N crates
        // produced this wall time, store the equal-work per-crate equivalent.
        // Prefer the compile-phase sample when the run split is known.
        const crateSampleMs = compileMs ?? (executeMs === null ? validRunMs : null);
        if (crateSampleMs === null) {
          return;
        }
        const workFactor = Math.max(1, context.crateKeys.length / context.parallelism);
        const sampleMs = crateSampleMs / workFactor;
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

export const CostModelLive: Layer.Layer<
  CostModel,
  never,
  DaemonConfig | KacheStatus | Ledger
> = Layer.effect(
  CostModel,
  Effect.gen(function* () {
    const config = yield* DaemonConfig;
    const kacheStatus = yield* KacheStatus;
    const ledger = yield* Ledger;
    return createCostModel({
      effectiveParallelism: config.jobsGrant > 0 ? config.jobsGrant : configuredParallelism(),
      kacheReader: null,
      kacheSnapshot: kacheStatus.priors,
      kacheStatus: kacheStatus.current,
      seedDurations: (intentKey, limit) => ledger.recentDurations(intentKey, limit),
      seedNeighborDurations: (input) => ledger.recentNeighborDurations(input),
      seedPhaseDurations: (intentKey, limit) => ledger.recentPhaseDurations(intentKey, limit),
    });
  }),
);
