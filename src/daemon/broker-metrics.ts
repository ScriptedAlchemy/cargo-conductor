import * as Metric from 'effect/Metric';

/** Broker-wide metrics, shared by the attachment and lane state machines. */

export const cargoRunMetric = Metric.timer('cargo_run_ms', {
  boundaries: [1e3, 5e3, 15e3, 3e4, 6e4, 12e4, 3e5],
});

export const jobOutcomeMetric = Metric.frequency('job_outcome', {
  preregisteredWords: ['done', 'failed', 'killed'],
});

export const attachModeMetric = Metric.frequency('attach_mode', {
  preregisteredWords: ['identity', 'coverage', 'batch'],
});
