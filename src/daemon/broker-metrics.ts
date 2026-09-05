import * as Metric from 'effect/Metric';

import { attachRejectionGates } from './protocol.js';

const cargoRunBoundaries = [1e3, 5e3, 15e3, 3e4, 6e4, 12e4, 3e5];

export const cargoRunMetric = Metric.timer('cargo_run_ms', {
  boundaries: cargoRunBoundaries,
});

export const waitMsSummary = Metric.summary('wait_ms_summary', {
  maxAge: '1 hour',
  maxSize: 512,
  quantiles: [0.5, 0.9, 0.95],
});

export const cargoRunKinds = [
  'check',
  'test',
  'nextest',
  'build',
  'clippy',
  'run',
  'other',
] as const;

export type CargoRunKind = (typeof cargoRunKinds)[number];

export const cargoRunKindForSubcommand = (subcommand: string): CargoRunKind => {
  switch (subcommand) {
    case 'check':
    case 'test':
    case 'nextest':
    case 'build':
    case 'clippy':
    case 'run':
      return subcommand;
    default:
      return 'other';
  }
};

export const cargoRunByKindMetric = (kind: string) =>
  Metric.withAttributes(cargoRunMetric, { kind: cargoRunKindForSubcommand(kind) });

export const jobOutcomeMetric = Metric.frequency('job_outcome', {
  preregisteredWords: ['done', 'failed', 'killed'],
});

export const attachModeMetric = Metric.frequency('attach_mode', {
  preregisteredWords: ['identity', 'coverage', 'batch'],
});

/**
 * One count per request that had in-flight leaders in its lane and rode
 * none of them, keyed by the gate of its nearest miss (daemon/coverage.ts).
 * Requests that arrive to an empty lane are not rejections and never count.
 */
export const attachRejectionMetric = Metric.frequency('attach_rejections', {
  preregisteredWords: attachRejectionGates,
});
