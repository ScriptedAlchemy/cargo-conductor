import { describe, expect, it } from 'effect-rstest';
import * as Duration from 'effect/Duration';
import * as Effect from 'effect/Effect';
import * as Metric from 'effect/Metric';

import {
  cargoRunByKindMetric,
  cargoRunKindForSubcommand,
  waitMsSummary,
} from '../src/daemon/broker-metrics.js';

const withFreshMetrics = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provideService(Metric.MetricRegistry, new Map()));

describe('broker metrics', () => {
  it.effect('maps unknown cargo subcommands into the other series', () =>
    withFreshMetrics(
      Effect.gen(function* () {
        yield* Metric.update(cargoRunByKindMetric('check'), Duration.millis(1_200));
        yield* Metric.update(
          cargoRunByKindMetric(cargoRunKindForSubcommand('fmt')),
          Duration.millis(800),
        );
        const check = yield* Metric.value(cargoRunByKindMetric('check'));
        const other = yield* Metric.value(cargoRunByKindMetric('other'));
        expect(check.count).toBe(1);
        expect(other.count).toBe(1);
        expect(other.max).toBe(800);
      }),
    ));

  it.effect('tracks wait summary count and quantiles', () =>
    withFreshMetrics(
      Effect.gen(function* () {
        yield* Metric.update(waitMsSummary, 100);
        yield* Metric.update(waitMsSummary, 400);
        yield* Metric.update(waitMsSummary, 900);
        const summary = yield* Metric.value(waitMsSummary);
        expect(summary.count).toBe(3);
        expect(summary.min).toBe(100);
        expect(summary.max).toBe(900);
        expect(summary.sum).toBe(1_400);
        expect(summary.quantiles.map(([quantile]) => quantile)).toEqual([0.5, 0.9, 0.95]);
      }),
    ));
});
