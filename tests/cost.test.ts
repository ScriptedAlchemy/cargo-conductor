import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { describe, expect, it } from '@rstest/core';
import * as Deferred from 'effect/Deferred';
import * as Effect from 'effect/Effect';
import * as Fiber from 'effect/Fiber';

import { createCostModel, defaultEstimateFor, openKacheReader } from '../src/daemon/cost.js';
import { normalizeCargoIntent } from '../src/daemon/intent-normalizer.js';

const intent = (argv: readonly string[], cwd = '/tmp/ws') =>
  normalizeCargoIntent({
    argv,
    cwd,
    env: {},
    workspaceRoot: cwd,
  });

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
      expect(reader?.maxCompileTimeMs('alpha', ['debug'])).toBe(1234);
      reader?.close();
      expect(reader?.maxCompileTimeMs('uncached', ['debug'])).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('createCostModel', () => {
  it('prefers EWMA of recorded outcomes over kache and defaults', async () => {
    const model = createCostModel({
      kacheReader: {
        close: () => {},
        maxCompileTimeMs: () => 50_000,
      },
      seedDurations: () => Effect.succeed([]),
    });
    const scoped = intent(['cargo', 'check', '-p', 'alpha']);
    await Effect.runPromise(model.recordOutcome(scoped.key, 20_000));
    const estimate = await Effect.runPromise(model.estimate(scoped));
    expect(estimate.source).toBe('ewma');
    expect(estimate.estimateMs).toBe(20_000);
  });

  it('falls back to the sum of kache crate priors when no EWMA exists', async () => {
    const model = createCostModel({
      kacheReader: {
        close: () => {},
        maxCompileTimeMs: (crateName) => (crateName === 'alpha' ? 12_000 : 8_000),
      },
      seedDurations: () => Effect.succeed([]),
    });
    const estimate = await Effect.runPromise(
      model.estimate(intent(['cargo', 'check', '-p', 'alpha', '-p', 'beta'])),
    );
    expect(estimate).toEqual({ estimateMs: 20_000, source: 'kache' });
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

  it('does not overwrite a concurrent outcome with stale seed data', async () => {
    const seedStarted = Effect.runSync(Deferred.make<void>());
    const releaseSeed = Effect.runSync(Deferred.make<void>());
    const model = createCostModel({
      kacheReader: null,
      seedDurations: () =>
        Deferred.succeed(seedStarted, undefined).pipe(
          Effect.andThen(Deferred.await(releaseSeed)),
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
});
