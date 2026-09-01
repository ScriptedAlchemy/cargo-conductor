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
  readonly estimate: (intent: NormalizedCargoIntent) => Effect.Effect<CostEstimate>;
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
  readonly maxCompileTimeMs: (crateName: string, profiles: readonly string[]) => number | null;
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
  try {
    db = new DatabaseSync(indexPath, { readOnly: true });
    db.prepare('SELECT compile_time_ms FROM entries LIMIT 1').get();
  } catch {
    try {
      db?.close();
    } catch {
      // A failed schema probe still degrades to no prior.
    }
    return null;
  }
  const readerDb = db;
  // The live index can hold ~100k rows with no crate_name index, so a scan
  // costs real time on a loaded machine. One combined scan per lookup, and a
  // TTL memo keeps repeat submissions off the submit critical path.
  const memoTtlMs = 10 * 60_000;
  const memo = new Map<string, { readonly atMs: number; readonly ms: number | null }>();
  return {
    close: () => {
      readerDb.close();
    },
    maxCompileTimeMs: (crateName, profiles) => {
      const memoKey = `${crateName}\0${profiles.join(',')}`;
      const cached = memo.get(memoKey);
      if (cached !== undefined && Date.now() - cached.atMs < memoTtlMs) {
        return cached.ms;
      }
      let ms: number | null = null;
      try {
        const placeholders = profiles.map(() => '?').join(', ');
        const row = readerDb
          .prepare(
            `SELECT
               MAX(CASE WHEN profile IN (${placeholders}) THEN compile_time_ms END) AS exact_ms,
               MAX(compile_time_ms) AS any_ms
             FROM entries WHERE crate_name = ?`,
          )
          .get(...profiles, crateName);
        const exactMs = row === undefined ? null : Number(row.exact_ms);
        const anyMs = row === undefined ? null : Number(row.any_ms);
        if (exactMs !== null && Number.isFinite(exactMs) && exactMs > 0) {
          ms = exactMs;
        } else if (anyMs !== null && Number.isFinite(anyMs) && anyMs > 0) {
          ms = anyMs;
        }
      } catch {
        ms = null;
      }
      memo.set(memoKey, { atMs: Date.now(), ms });
      return ms;
    },
  };
};

const kacheEstimate = (
  reader: KacheReader | null,
  intent: NormalizedCargoIntent,
): number | null => {
  if (reader === null || intent.workspace || intent.packages.length === 0) {
    return null;
  }
  const profiles = kacheProfilesFor(intent.profile);
  let total = 0;
  let found = 0;
  for (const name of intent.packages) {
    const ms = reader.maxCompileTimeMs(name, profiles);
    if (ms !== null) {
      total += ms;
      found += 1;
    }
  }
  return found === 0 ? null : total;
};

export interface CreateCostModelOptions {
  readonly kacheReader: KacheReader | null;
  readonly seedDurations: (intentKey: string, limit: number) => Effect.Effect<readonly number[]>;
}

export const createCostModel = (options: CreateCostModelOptions): CostModelApi => {
  /** intentKey -> EWMA of observed run durations; null marks "seeded, empty". */
  const ewma = SynchronizedRef.unsafeMake<ReadonlyMap<string, number | null>>(new Map());

  const seededEwma = (intentKey: string): Effect.Effect<number | null> =>
    SynchronizedRef.modifyEffect(ewma, (current) => {
      if (current.has(intentKey)) {
        return Effect.succeed([current.get(intentKey) ?? null, current] as const);
      }
      return options.seedDurations(intentKey, ewmaSeedLimit).pipe(
        Effect.map((durations) => {
          let value: number | null = null;
          // Seed oldest-first so the newest observation weighs the most.
          for (const runMs of [...durations].reverse()) {
            value = value === null ? runMs : value + ewmaAlpha * (runMs - value);
          }
          const updated = new Map(current);
          updated.set(intentKey, value);
          return [value, updated] as const;
        }),
      );
    });

  return {
    estimate: (intent) =>
      Effect.gen(function* () {
        const observed = yield* seededEwma(intent.key);
        if (observed !== null) {
          return { estimateMs: Math.round(observed), source: 'ewma' as const };
        }
        const prior = kacheEstimate(options.kacheReader, intent);
        if (prior !== null) {
          return { estimateMs: Math.round(prior), source: 'kache' as const };
        }
        return { estimateMs: defaultEstimateFor(intent), source: 'default' as const };
      }),
    recordOutcome: (intentKey, runMs) =>
      SynchronizedRef.update(ewma, (current) => {
        const observed = current.get(intentKey);
        const base = observed === undefined || observed === null ? runMs : observed;
        const updated = new Map(current);
        updated.set(intentKey, base + ewmaAlpha * (runMs - base));
        return updated;
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
    return createCostModel({
      kacheReader,
      seedDurations: (intentKey, limit) => ledger.recentDurations(intentKey, limit),
    });
  }),
);
