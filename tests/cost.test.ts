import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';

import { describe, expect, it } from '@rstest/core';
import * as Deferred from 'effect/Deferred';
import * as Effect from 'effect/Effect';
import * as Fiber from 'effect/Fiber';

import {
  createCostModel,
  defaultEstimateFor,
  openKacheReader,
  readKacheEventPriors,
} from '../src/daemon/cost.js';
import type { KacheIndexPriors } from '../src/daemon/cost.js';
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
  it('loads index priors in the background without blocking a cold estimate', async () => {
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

    const cold = await Effect.runPromise(model.estimate(scoped));
    expect(cold).toEqual({ estimateMs: 120_000, source: 'default' });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    const warm = await Effect.runPromise(model.estimate(scoped));

    expect(loads).toBe(1);
    expect(warm).toEqual({ estimateMs: 7_000, source: 'kache' });
  });

  it('prefers EWMA of recorded outcomes over kache and defaults', async () => {
    const model = createCostModel({
      kachePriors: {
        initial: indexPriors(() => 50_000),
      },
      kacheReader: null,
      seedDurations: () => Effect.succeed([]),
    });
    const scoped = intent(['cargo', 'check', '-p', 'alpha']);
    await Effect.runPromise(model.recordOutcome(scoped.key, 20_000));
    const estimate = await Effect.runPromise(model.estimate(scoped));
    expect(estimate.source).toBe('ewma');
    expect(estimate.estimateMs).toBe(20_000);
  });

  it('uses parallelism-discounted kache crate priors when no EWMA exists', async () => {
    const model = createCostModel({
      kachePriors: {
        initial: indexPriors((crateName) => (crateName === 'alpha' ? 12_000 : 8_000)),
      },
      kacheReader: null,
      effectiveParallelism: 4,
      seedDurations: () => Effect.succeed([]),
    });
    const estimate = await Effect.runPromise(
      model.estimate(intent(['cargo', 'check', '-p', 'alpha', '-p', 'beta'])),
    );
    expect(estimate).toEqual({ estimateMs: 12_000, source: 'kache' });
  });

  it('reuses crate/profile/subcommand-class observations for a new intent key', async () => {
    const model = createCostModel({
      kacheReader: null,
      seedDurations: () => Effect.succeed([]),
    });
    const observed = intent(['cargo', 'check', '-p', 'alpha']);
    await Effect.runPromise(model.estimate(observed));
    await Effect.runPromise(model.recordOutcome(observed.key, 20_000));

    const sameClass = await Effect.runPromise(
      model.estimate(intent(['cargo', 'clippy', '-p', 'alpha', '--all-features'])),
    );
    const otherProfile = await Effect.runPromise(
      model.estimate(intent(['cargo', 'check', '--release', '-p', 'alpha'])),
    );

    expect(sameClass).toEqual({ estimateMs: 20_000, source: 'ewma' });
    expect(otherProfile).toEqual({ estimateMs: 120_000, source: 'default' });
  });

  it('accounts for closure crates with a parallelism-discounted critical-path estimate', async () => {
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

    const estimate = await Effect.runPromise(
      model.estimate(
        intent(['cargo', 'check', '-p', 'alpha']),
        new Set(['alpha', 'beta', 'gamma', 'delta']),
      ),
    );

    // max(largest crate 10s, total 28s / two cargo workers) = 14s.
    expect(estimate).toEqual({ estimateMs: 14_000, source: 'kache' });
  });

  it('starts event-prior refresh in the background and clears the refresh flag after failure', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cc-kache-events-refresh-'));
    const eventsPath = join(root, 'events.jsonl');
    writeFileSync(
      eventsPath,
      `${JSON.stringify({ crate_name: 'alpha', profile: 'dev', compile_time_ms: 3_000 })}\n`,
    );
    const loaded = readKacheEventPriors(eventsPath);
    const releaseLoad = Effect.runSync(Deferred.make<void>());
    let attempts = 0;
    try {
      const model = createCostModel({
        eventPriors: {
          load: () => {
            attempts += 1;
            return attempts === 1
              ? Effect.fail(new Error('transient'))
              : Deferred.await(releaseLoad).pipe(Effect.as(loaded));
          },
          ttlMs: 0,
        },
        kacheReader: null,
        seedDurations: () => Effect.succeed([]),
      });
      const scoped = intent(['cargo', 'check', '-p', 'alpha']);

      const cold = await Effect.runPromise(model.estimate(scoped));
      expect(cold.source).toBe('default');
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });

      const stillCold = await Effect.runPromise(model.estimate(scoped));
      expect(stillCold.source).toBe('default');
      await Effect.runPromise(Deferred.succeed(releaseLoad, undefined));
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      const refreshed = await Effect.runPromise(model.estimate(scoped));

      expect(attempts).toBeGreaterThanOrEqual(2);
      expect(refreshed).toEqual({ estimateMs: 3_000, source: 'kache' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps whole-intent EWMA estimates below one millisecond on the warm path', () => {
    const model = createCostModel({
      kacheReader: null,
      seedDurations: () => Effect.succeed([]),
    });
    const scoped = intent(['cargo', 'check', '-p', 'alpha']);
    Effect.runSync(model.recordOutcome(scoped.key, 20_000));
    Effect.runSync(model.estimate(scoped));

    const iterations = 1_000;
    const startedAt = performance.now();
    for (let index = 0; index < iterations; index += 1) {
      Effect.runSync(model.estimate(scoped));
    }
    const averageMs = (performance.now() - startedAt) / iterations;

    expect(averageMs).toBeLessThan(1);
  });

  it('blends event timings with the index prior when both are available', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cc-kache-events-blend-'));
    const eventsPath = join(root, 'events.jsonl');
    try {
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

      const estimate = await Effect.runPromise(
        model.estimate(intent(['cargo', 'check', '-p', 'alpha'])),
      );

      expect(estimate.source).toBe('kache');
      expect(estimate.estimateMs).toBeGreaterThan(1_000);
      expect(estimate.estimateMs).toBeLessThan(3_000);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('seeds EWMA oldest-first so the newest observation weighs more', async () => {
    const model = createCostModel({
      kacheReader: null,
      seedDurations: () => Effect.succeed([40_000, 10_000]),
    });
    const scoped = intent(['cargo', 'test', '-p', 'alpha']);
    const estimate = await Effect.runPromise(model.estimate(scoped));
    expect(estimate.source).toBe('ewma');
    // seed [40k, 10k] newest-first after reverse: 10k then 40k
    // value = 10_000; then 10_000 + 0.4 * (40_000 - 10_000) = 22_000
    expect(estimate.estimateMs).toBe(22_000);
  });

  it('uses the default prior when kache and history are empty', async () => {
    const model = createCostModel({
      kacheReader: null,
      seedDurations: () => Effect.succeed([]),
    });
    const estimate = await Effect.runPromise(model.estimate(intent(['cargo', 'clippy', '-p', 'alpha'])));
    expect(estimate).toEqual({ estimateMs: 150_000, source: 'default' });
  });

  it('sanitizes invalid history and prior values into a positive finite estimate', async () => {
    const model = createCostModel({
      kachePriors: {
        initial: indexPriors(() => Number.NaN),
      },
      kacheReader: null,
      seedDurations: () => Effect.die(new Error('bad history')),
    });
    const scoped = intent(['cargo', 'check', '-p', 'alpha']);

    await Effect.runPromise(model.recordOutcome(scoped.key, Number.POSITIVE_INFINITY));
    const estimate = await Effect.runPromise(model.estimate(scoped));

    expect(Number.isFinite(estimate.estimateMs)).toBe(true);
    expect(estimate.estimateMs).toBeGreaterThan(0);
    expect(estimate).toEqual({ estimateMs: 120_000, source: 'default' });
  });

  it('does not overwrite a concurrent outcome with stale seed data', async () => {
    const seedStarted = Effect.runSync(Deferred.make<void>());
    const releaseSeed = Effect.runSync(Deferred.make<void>());
    const model = createCostModel({
      kacheReader: null,
      seedDurations: () =>
        Deferred.succeed(seedStarted, undefined).pipe(
          Effect.zipRight(Deferred.await(releaseSeed)),
          Effect.as([100] as const),
        ),
    });
    const scoped = intent(['cargo', 'check', '-p', 'alpha']);

    const estimateFiber = Effect.runFork(model.estimate(scoped));
    await Effect.runPromise(Deferred.await(seedStarted));
    const outcomeFiber = Effect.runFork(model.recordOutcome(scoped.key, 200));
    await Effect.runPromise(Deferred.succeed(releaseSeed, undefined));

    const estimate = await Effect.runPromise(Fiber.join(estimateFiber));
    await Effect.runPromise(Fiber.join(outcomeFiber));
    const updated = await Effect.runPromise(model.estimate(scoped));

    expect(estimate.estimateMs).toBe(100);
    expect(updated).toEqual({ estimateMs: 140, source: 'ewma' });
  });

  it('evicts the least-recently-used whole-intent estimate after the cache cap', async () => {
    const seedCalls = new Map<string, number>();
    const model = createCostModel({
      kacheReader: null,
      seedDurations: (intentKey) => {
        seedCalls.set(intentKey, (seedCalls.get(intentKey) ?? 0) + 1);
        return Effect.succeed([]);
      },
    });
    const first = intent(['cargo', 'check', '-p', 'crate-0']);
    await Effect.runPromise(model.estimate(first));
    for (let index = 1; index <= 4_096; index += 1) {
      await Effect.runPromise(model.estimate(intent(['cargo', 'check', '-p', `crate-${index}`])));
    }
    await Effect.runPromise(model.estimate(first));

    expect(seedCalls.get(first.key)).toBe(2);
  });
});

const realKacheIndexPath = '/fast/cache/kache/index.db';
const realKacheEventsPath = '/fast/cache/kache/events.jsonl';

describe('real kache calibration', () => {
  it.skipIf(!existsSync(realKacheIndexPath) || !existsSync(realKacheEventsPath))(
    'produces a sane grounded estimate from a bounded real-data sample',
    async () => {
      const events = readKacheEventPriors(realKacheEventsPath);
      const reader = openKacheReader(realKacheIndexPath);
      expect(reader).not.toBeNull();
      try {
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
        const estimate = await Effect.runPromise(model.estimate(scoped));

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
      } finally {
        reader?.close();
      }
    },
  );
});
