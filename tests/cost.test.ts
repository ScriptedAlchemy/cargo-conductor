import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';

import { describe, expect, it } from 'effect-rstest';
import * as Deferred from 'effect/Deferred';
import * as Data from 'effect/Data';
import * as Effect from 'effect/Effect';
import * as Fiber from 'effect/Fiber';
import type * as Scope from 'effect/Scope';

import {
  createCostModel,
  defaultEstimateFor,
  openKacheReader,
  readKacheEventPriors,
} from '../src/daemon/cost.js';
import type { KacheIndexPriors } from '../src/daemon/cost.js';
import { resolveDaemonConfig } from '../src/daemon/config.js';
import { normalizeCargoIntent } from '../src/daemon/intent-normalizer.js';

const intent = (argv: readonly string[], cwd = '/tmp/ws') =>
  normalizeCargoIntent({
    argv,
    cwd,
    env: {},
    workspaceRoot: cwd,
  });

const indexPriors = (
  compileTimeMs: KacheIndexPriors['compileTimeMs'],
): KacheIndexPriors => ({ compileTimeMs });

class TransientError extends Data.TaggedError('TransientError')<{}> {}

/** A fresh temp directory, removed when the enclosing scope closes. */
const scopedTempDir = (prefix: string): Effect.Effect<string, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync(() => mkdtempSync(join(tmpdir(), prefix))),
    (root) => Effect.sync(() => rmSync(root, { recursive: true, force: true })),
  );

/** Lets detached background fibers (prior refreshes) run for one macrotask turn. */
const nextMacrotask = Effect.promise(
  () =>
    new Promise<void>((resolve) => {
      setImmediate(resolve);
    }),
);

describe('defaultEstimateFor', () => {
  it('uses mined p50 priors and doubles workspace-wide work', () => {
    expect(defaultEstimateFor(intent(['cargo', 'fmt']))).toBe(10_000);
    expect(defaultEstimateFor(intent(['cargo', 'check', '-p', 'alpha']))).toBe(120_000);
    expect(defaultEstimateFor(intent(['cargo', 'check', '--workspace']))).toBe(240_000);
    expect(defaultEstimateFor(intent(['cargo', 'build', '-p', 'alpha']))).toBe(300_000);
  });
});

describe('openKacheReader', () => {
  it('exposes a closeable read-only database handle', () => {
    const root = mkdtempSync(join(tmpdir(), 'cc-kache-reader-'));
    const indexPath = join(root, 'index.db');
    try {
      const database = new DatabaseSync(indexPath);
      database.exec(
        'CREATE TABLE entries (crate_name TEXT, profile TEXT, compile_time_ms INTEGER)',
      );
      database
        .prepare('INSERT INTO entries (crate_name, profile, compile_time_ms) VALUES (?, ?, ?)')
        .run('alpha', 'debug', 1234);
      database.close();

      const reader = openKacheReader(indexPath);
      const priors = reader?.load();
      expect(priors?.compileTimeMs('alpha', ['debug'])).toBe(1234);
      reader?.close();
      expect(priors?.compileTimeMs('uncached', ['debug'])).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns null when the index is explicitly disabled via an empty path', () => {
    expect(openKacheReader('')).toBeNull();
  });

  it('returns null for a missing index file on a fresh machine', () => {
    const root = mkdtempSync(join(tmpdir(), 'cc-kache-reader-missing-'));
    try {
      expect(openKacheReader(join(root, 'index.db'))).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns null when the index file is not a SQLite database', () => {
    const root = mkdtempSync(join(tmpdir(), 'cc-kache-reader-corrupt-'));
    const indexPath = join(root, 'index.db');
    try {
      writeFileSync(indexPath, 'not a sqlite database at all');
      expect(openKacheReader(indexPath)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns null when the schema lacks the expected columns (kache version drift)', () => {
    const root = mkdtempSync(join(tmpdir(), 'cc-kache-reader-schema-'));
    const indexPath = join(root, 'index.db');
    try {
      const database = new DatabaseSync(indexPath);
      database.exec('CREATE TABLE entries (crate_name TEXT)');
      database.close();
      expect(openKacheReader(indexPath)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('degrades load() to empty priors when the index is corrupted after open', () => {
    const root = mkdtempSync(join(tmpdir(), 'cc-kache-reader-midrun-'));
    const indexPath = join(root, 'index.db');
    try {
      const database = new DatabaseSync(indexPath);
      database.exec(
        'CREATE TABLE entries (crate_name TEXT, profile TEXT, compile_time_ms INTEGER)',
      );
      const insert = database.prepare(
        'INSERT INTO entries (crate_name, profile, compile_time_ms) VALUES (?, ?, ?)',
      );
      // Enough rows that the table spills past the first page, so the
      // truncated overwrite below is guaranteed to invalidate reads.
      for (let index = 0; index < 2_000; index += 1) {
        insert.run(`crate-${index}`, 'debug', index + 1);
      }
      database.close();

      const reader = openKacheReader(indexPath);
      expect(reader).not.toBeNull();
      expect(reader?.load().compileTimeMs('crate-0', ['debug'])).toBe(1);

      writeFileSync(indexPath, 'kache re-initialized this file mid-run');

      const degraded = reader?.load();
      expect(degraded?.compileTimeMs('crate-0', ['debug'])).toBeNull();
      expect(() => {
        reader?.close();
        reader?.close();
      }).not.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.effect('keeps estimates flowing on defaults when a reader throws mid-run', () =>
    Effect.gen(function* () {
      // Belt and braces above the load() guard: even a reader that throws
      // outright must leave the cost model on default priors, not defect.
      const model = createCostModel({
        kacheReader: {
          close: () => {},
          load: () => {
            throw new Error('file is not a database');
          },
        },
        seedDurations: () => Effect.succeed([]),
      });
      const scoped = intent(['cargo', 'check', '-p', 'alpha']);

      const cold = yield* model.estimate(scoped);
      expect(cold).toEqual({ estimateMs: 120_000, source: 'default' });
      yield* nextMacrotask;
      const afterFailedRefresh = yield* model.estimate(scoped);
      expect(afterFailedRefresh).toEqual({ estimateMs: 120_000, source: 'default' });
    }));
});

describe('readKacheEventPriors', () => {
  it('bounds tail reads and aggregates compile outcomes and heartbeats by crate/profile', () => {
    const root = mkdtempSync(join(tmpdir(), 'cc-kache-events-'));
    const eventsPath = join(root, 'events.jsonl');
    try {
      const events = [
        JSON.stringify({ crate_name: 'alpha', profile: 'dev', compile_time_ms: 400 }),
        JSON.stringify({ crate_name: 'alpha', profile: 'dev', compile_time_ms: 800 }),
        JSON.stringify({ crate_name: 'alpha', profile: 'release', compile_time_ms: 1_200 }),
        JSON.stringify({
          event: 'heartbeat',
          crate_name: 'beta',
          profile: 'dev',
          elapsed_s: 2,
        }),
        JSON.stringify({ crate_name: 'gamma', compile_time_ms: 900 }),
        '{malformed',
      ].join('\n');
      writeFileSync(eventsPath, `${'discarded'.repeat(2_000)}\n${events}\n`);

      const priors = readKacheEventPriors(eventsPath, 2_048);

      expect(priors.bytesRead).toBeLessThanOrEqual(2_048);
      expect(priors.compileTimeMs('alpha', ['dev', 'debug'])).toBeGreaterThanOrEqual(400);
      expect(priors.compileTimeMs('alpha', ['dev', 'debug'])).toBeLessThanOrEqual(800);
      expect(priors.compileTimeMs('alpha', ['release'])).toBe(1_200);
      expect(priors.compileTimeMs('beta', ['dev'])).toBe(2_000);
      expect(priors.compileTimeMs('gamma', ['release'])).toBe(900);
      expect(priors.compileTimeMs('missing', ['dev'])).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('createCostModel', () => {
  it.effect('loads index priors in the background without blocking a cold estimate', () =>
    Effect.gen(function* () {
      let loads = 0;
      const model = createCostModel({
        kacheReader: {
          close: () => {},
          load: () => {
            loads += 1;
            return indexPriors(() => 7_000);
          },
        },
        seedDurations: () => Effect.succeed([]),
      });
      const scoped = intent(['cargo', 'check', '-p', 'alpha']);

      const cold = yield* model.estimate(scoped);
      expect(cold).toEqual({ estimateMs: 120_000, source: 'default' });
      yield* nextMacrotask;
      const warm = yield* model.estimate(scoped);

      expect(loads).toBe(1);
      expect(warm).toEqual({ estimateMs: 7_000, source: 'kache' });
    }));

  it.effect('prefers EWMA of recorded outcomes over kache and defaults', () =>
    Effect.gen(function* () {
      const model = createCostModel({
        kachePriors: {
          initial: indexPriors(() => 50_000),
        },
        kacheReader: null,
        seedDurations: () => Effect.succeed([]),
      });
      const scoped = intent(['cargo', 'check', '-p', 'alpha']);
      yield* model.recordOutcome(scoped.key, 20_000);
      const estimate = yield* model.estimate(scoped);
      expect(estimate.source).toBe('ewma');
      expect(estimate.estimateMs).toBe(20_000);
    }));

  it.effect('uses parallelism-discounted kache crate priors when no EWMA exists', () =>
    Effect.gen(function* () {
      const model = createCostModel({
        kachePriors: {
          initial: indexPriors((crateName) => (crateName === 'alpha' ? 12_000 : 8_000)),
        },
        kacheReader: null,
        effectiveParallelism: 4,
        seedDurations: () => Effect.succeed([]),
      });
      const estimate = yield* model.estimate(intent(['cargo', 'check', '-p', 'alpha', '-p', 'beta']));
      expect(estimate).toEqual({ estimateMs: 12_000, source: 'kache' });
    }));

  it.effect('tries release priors before crate-wide fallback for custom profiles', () =>
    Effect.gen(function* () {
      let requestedProfiles: readonly string[] = [];
      const model = createCostModel({
        kachePriors: {
          initial: indexPriors((_crateName, profiles) => {
            requestedProfiles = profiles;
            return profiles.includes('release') ? 12_000 : 90_000;
          }),
        },
        kacheReader: null,
        seedDurations: () => Effect.succeed([]),
      });

      const estimate = yield* model.estimate(
        intent(['cargo', 'build', '--profile', 'perf', '-p', 'alpha']),
      );

      expect(requestedProfiles).toEqual(['perf', 'release']);
      expect(estimate).toEqual({ estimateMs: 12_000, source: 'kache' });
    }));

  it.effect('keeps dev, test, and bench kache profile aliases', () =>
    Effect.gen(function* () {
      const cases = [
        { argv: ['cargo', 'check', '-p', 'alpha'], profiles: ['dev', 'debug'] },
        { argv: ['cargo', 'test', '-p', 'alpha'], profiles: ['test', 'debug'] },
        { argv: ['cargo', 'bench', '-p', 'alpha'], profiles: ['bench', 'release'] },
      ] as const;

      for (const testCase of cases) {
        let requestedProfiles: readonly string[] = [];
        const model = createCostModel({
          kachePriors: {
            initial: indexPriors((_crateName, profiles) => {
              requestedProfiles = profiles;
              return 1_000;
            }),
          },
          kacheReader: null,
          seedDurations: () => Effect.succeed([]),
        });
        yield* model.estimate(intent(testCase.argv));
        expect(requestedProfiles).toEqual(testCase.profiles);
      }
    }));

  it.effect('reuses crate/profile/subcommand-class observations for a new intent key', () =>
    Effect.gen(function* () {
      const model = createCostModel({
        kacheReader: null,
        seedDurations: () => Effect.succeed([]),
      });
      const observed = intent(['cargo', 'check', '-p', 'alpha']);
      yield* model.estimate(observed);
      yield* model.recordOutcome(observed.key, 20_000);

      const sameClass = yield* model.estimate(
        intent(['cargo', 'clippy', '-p', 'alpha', '--all-features']),
      );
      const otherProfile = yield* model.estimate(
        intent(['cargo', 'check', '--release', '-p', 'alpha']),
      );

      expect(sameClass).toEqual({ estimateMs: 20_000, source: 'ewma' });
      expect(otherProfile).toEqual({ estimateMs: 120_000, source: 'default' });
    }));

  it.effect('accounts for closure crates with a parallelism-discounted critical-path estimate', () =>
    Effect.gen(function* () {
      const costs = new Map([
        ['alpha', 10_000],
        ['beta', 8_000],
        ['gamma', 6_000],
        ['delta', 4_000],
      ]);
      const model = createCostModel({
        kachePriors: {
          initial: indexPriors((crateName) => costs.get(crateName) ?? null),
        },
        kacheReader: null,
        effectiveParallelism: 2,
        seedDurations: () => Effect.succeed([]),
      });

      const estimate = yield* model.estimate(
        intent(['cargo', 'check', '-p', 'alpha']),
        new Set(['alpha', 'beta', 'gamma', 'delta']),
      );

      // max(largest crate 10s, total 28s / two cargo workers) = 14s.
      expect(estimate).toEqual({ estimateMs: 14_000, source: 'kache' });
    }));

  it.effect('starts event-prior refresh in the background and clears the refresh flag after failure', () =>
    Effect.gen(function* () {
      const root = yield* scopedTempDir('cc-kache-events-refresh-');
      const eventsPath = join(root, 'events.jsonl');
      writeFileSync(
        eventsPath,
        `${JSON.stringify({ crate_name: 'alpha', profile: 'dev', compile_time_ms: 3_000 })}\n`,
      );
      const loaded = readKacheEventPriors(eventsPath);
      const releaseLoad = Deferred.makeUnsafe<void>();
      let attempts = 0;
      const model = createCostModel({
        eventPriors: {
          load: () => {
            attempts += 1;
            return attempts === 1
              ? Effect.fail(new TransientError())
              : Deferred.await(releaseLoad).pipe(Effect.as(loaded));
          },
          ttlMs: 0,
        },
        kacheReader: null,
        seedDurations: () => Effect.succeed([]),
      });
      const scoped = intent(['cargo', 'check', '-p', 'alpha']);

      const cold = yield* model.estimate(scoped);
      expect(cold.source).toBe('default');
      yield* nextMacrotask;

      const stillCold = yield* model.estimate(scoped);
      expect(stillCold.source).toBe('default');
      yield* Deferred.succeed(releaseLoad, undefined);
      yield* nextMacrotask;
      const refreshed = yield* model.estimate(scoped);

      expect(attempts).toBeGreaterThanOrEqual(2);
      expect(refreshed).toEqual({ estimateMs: 3_000, source: 'kache' });
    }));

  it.live('keeps whole-intent EWMA estimates below one millisecond on the warm path', () =>
    Effect.gen(function* () {
      const model = createCostModel({
        kacheReader: null,
        seedDurations: () => Effect.succeed([]),
      });
      const scoped = intent(['cargo', 'check', '-p', 'alpha']);
      yield* model.recordOutcome(scoped.key, 20_000);
      yield* model.estimate(scoped);

      const iterations = 1_000;
      const startedAt = performance.now();
      for (let index = 0; index < iterations; index += 1) {
        yield* model.estimate(scoped);
      }
      const averageMs = (performance.now() - startedAt) / iterations;

      expect(averageMs).toBeLessThan(1);
    }));

  it.effect('blends event timings with the index prior when both are available', () =>
    Effect.gen(function* () {
      const root = yield* scopedTempDir('cc-kache-events-blend-');
      const eventsPath = join(root, 'events.jsonl');
      writeFileSync(
        eventsPath,
        `${JSON.stringify({ crate_name: 'alpha', profile: 'dev', compile_time_ms: 3_000 })}\n`,
      );
      const model = createCostModel({
        eventPriors: { initial: readKacheEventPriors(eventsPath), load: () => Effect.never },
        kachePriors: {
          initial: indexPriors(() => 1_000),
        },
        kacheReader: null,
        seedDurations: () => Effect.succeed([]),
      });

      const estimate = yield* model.estimate(intent(['cargo', 'check', '-p', 'alpha']));

      expect(estimate.source).toBe('kache');
      expect(estimate.estimateMs).toBeGreaterThan(1_000);
      expect(estimate.estimateMs).toBeLessThan(3_000);
    }));

  it.effect('seeds EWMA oldest-first so the newest observation weighs more', () =>
    Effect.gen(function* () {
      const model = createCostModel({
        kacheReader: null,
        seedDurations: () => Effect.succeed([40_000, 10_000]),
      });
      const scoped = intent(['cargo', 'test', '-p', 'alpha']);
      const estimate = yield* model.estimate(scoped);
      expect(estimate.source).toBe('ewma');
      // seed [40k, 10k] newest-first after reverse: 10k then 40k
      // value = 10_000; then 10_000 + 0.4 * (40_000 - 10_000) = 22_000
      expect(estimate.estimateMs).toBe(22_000);
    }));

  it.effect('uses the default prior when kache and history are empty', () =>
    Effect.gen(function* () {
      const model = createCostModel({
        kacheReader: null,
        seedDurations: () => Effect.succeed([]),
      });
      const estimate = yield* model.estimate(intent(['cargo', 'clippy', '-p', 'alpha']));
      expect(estimate).toEqual({ estimateMs: 150_000, source: 'default' });
    }));

  it.effect('sanitizes invalid history and prior values into a positive finite estimate', () =>
    Effect.gen(function* () {
      const model = createCostModel({
        kachePriors: {
          initial: indexPriors(() => Number.NaN),
        },
        kacheReader: null,
        seedDurations: () => Effect.die(new Error('bad history')),
      });
      const scoped = intent(['cargo', 'check', '-p', 'alpha']);

      yield* model.recordOutcome(scoped.key, Number.POSITIVE_INFINITY);
      const estimate = yield* model.estimate(scoped);

      expect(Number.isFinite(estimate.estimateMs)).toBe(true);
      expect(estimate.estimateMs).toBeGreaterThan(0);
      expect(estimate).toEqual({ estimateMs: 120_000, source: 'default' });
    }));

  it.effect('does not overwrite a concurrent outcome with stale seed data', () =>
    Effect.gen(function* () {
      const seedStarted = Deferred.makeUnsafe<void>();
      const releaseSeed = Deferred.makeUnsafe<void>();
      const model = createCostModel({
        kacheReader: null,
        seedDurations: () =>
          Deferred.succeed(seedStarted, undefined).pipe(
            Effect.andThen(Deferred.await(releaseSeed)),
            Effect.as([100] as const),
          ),
      });
      const scoped = intent(['cargo', 'check', '-p', 'alpha']);

      const estimateFiber = yield* Effect.forkChild(model.estimate(scoped));
      yield* Deferred.await(seedStarted);
      const outcomeFiber = yield* Effect.forkChild(model.recordOutcome(scoped.key, 200));
      yield* Deferred.succeed(releaseSeed, undefined);

      const estimate = yield* Fiber.join(estimateFiber);
      yield* Fiber.join(outcomeFiber);
      const updated = yield* model.estimate(scoped);

      expect(estimate.estimateMs).toBe(100);
      expect(updated).toEqual({ estimateMs: 140, source: 'ewma' });
    }));

  it.effect('evicts the least-recently-used whole-intent estimate after the cache cap', () =>
    Effect.gen(function* () {
      const seedCalls = new Map<string, number>();
      const model = createCostModel({
        kacheReader: null,
        seedDurations: (intentKey) => {
          seedCalls.set(intentKey, (seedCalls.get(intentKey) ?? 0) + 1);
          return Effect.succeed([]);
        },
      });
      const first = intent(['cargo', 'check', '-p', 'crate-0']);
      yield* model.estimate(first);
      for (let index = 1; index <= 4_096; index += 1) {
        yield* model.estimate(intent(['cargo', 'check', '-p', `crate-${index}`]));
      }
      yield* model.estimate(first);

      expect(seedCalls.get(first.key)).toBe(2);
    }));
});

// Opt-in grounding against live kache data: runs only where the resolved
// kache index (CARGO_HAULER_KACHE_INDEX or the per-user cache default)
// actually exists; hermetic CI machines skip it.
const realKacheIndexPath = resolveDaemonConfig(process.env).kacheIndexPath;
const realKacheEventsPath =
  realKacheIndexPath.length === 0 ? '' : join(dirname(realKacheIndexPath), 'events.jsonl');

describe('real kache calibration', () => {
  it.live.skipIf(!existsSync(realKacheIndexPath) || !existsSync(realKacheEventsPath))(
    'produces a sane grounded estimate from a bounded real-data sample',
    () =>
      Effect.gen(function* () {
        const events = readKacheEventPriors(realKacheEventsPath);
        const reader = yield* Effect.acquireRelease(
          Effect.sync(() => openKacheReader(realKacheIndexPath)),
          (opened) => Effect.sync(() => opened?.close()),
        );
        expect(reader).not.toBeNull();
        const index = reader?.load();
        const model = createCostModel({
          eventPriors: { initial: events, load: () => Effect.never },
          kachePriors: index === undefined ? undefined : { initial: index },
          kacheReader: reader,
          effectiveParallelism: 4,
          seedDurations: () => Effect.succeed([]),
        });
        const scoped = intent([
          'cargo',
          'build',
          '--release',
          '-p',
          'tracedecay',
        ]);
        const indexMs = index?.compileTimeMs('tracedecay', ['release']) ?? null;
        const eventMs = events.compileTimeMs('tracedecay', ['release']);
        const estimate = yield* model.estimate(scoped);

        expect(events.bytesRead).toBeLessThanOrEqual(8 * 1024 * 1024);
        expect(events.sampleCount).toBeGreaterThan(0);
        expect(estimate.source).toBe('kache');
        expect(Number.isFinite(estimate.estimateMs)).toBe(true);
        expect(estimate.estimateMs).toBeGreaterThanOrEqual(100);
        expect(estimate.estimateMs).toBeLessThanOrEqual(24 * 60 * 60_000);
        console.info('real kache calibration', {
          bytesRead: events.bytesRead,
          eventMs,
          indexMs,
          estimateMs: estimate.estimateMs,
          sampleCount: events.sampleCount,
        });
      }),
  );
});
