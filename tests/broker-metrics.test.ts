import { describe, expect, it } from '@rstest/core';
import * as Duration from 'effect/Duration';
import * as Effect from 'effect/Effect';
import * as Metric from 'effect/Metric';

import {
  cargoRunByKindMetric,
  cargoRunKindForSubcommand,
  waitMsSummary,
} from '../src/daemon/broker-metrics.js';

const runWithFreshMetrics = <A>(effect: Effect.Effect<A>) =>
  Effect.runPromise(effect.pipe(Effect.provideService(Metric.MetricRegistry, new Map())));

describe('broker metrics', () => {
  it('maps unknown cargo subcommands into the other series', async () => {
    const snapshots = await runWithFreshMetrics(
      Effect.gen(function* () {
        yield* Metric.update(cargoRunByKindMetric('check'), Duration.millis(1_200));
        yield* Metric.update(
          cargoRunByKindMetric(cargoRunKindForSubcommand('fmt')),
          Duration.millis(800),
        );
        const check = yield* Metric.value(cargoRunByKindMetric('check'));
        const other = yield* Metric.value(cargoRunByKindMetric('other'));
        return { check, other };
      }),
    );
    expect(snapshots.check.count).toBe(1);
    expect(snapshots.other.count).toBe(1);
    expect(snapshots.other.max).toBe(800);
  });

  it('tracks wait summary count and quantiles', async () => {
    const summary = await runWithFreshMetrics(
      Effect.gen(function* () {
        yield* Metric.update(waitMsSummary, 100);
        yield* Metric.update(waitMsSummary, 400);
        yield* Metric.update(waitMsSummary, 900);
        return yield* Metric.value(waitMsSummary);
      }),
    );
    expect(summary.count).toBe(3);
    expect(summary.min).toBe(100);
    expect(summary.max).toBe(900);
    expect(summary.sum).toBe(1_400);
    expect(summary.quantiles.map(([quantile]) => quantile)).toEqual([0.5, 0.9, 0.95]);
  });
});
