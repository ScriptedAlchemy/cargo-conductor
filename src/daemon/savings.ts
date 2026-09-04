import type { AttachMode, SavedComputeSource } from './protocol.js';

export interface ServedSavings {
  readonly savedComputeMs: number;
  readonly savedComputeSource: SavedComputeSource;
  readonly savedLatencyMs: number;
}

export const nonNegativeMs = (value: number): number => Math.max(0, Math.round(value));

/**
 * Counterfactual credit for one request served by another cargo process.
 * Latency remains signed: a rider that waited longer than its own estimated
 * run would have taken must show the regression rather than hide it.
 */
export const calculateServedSavings = (
  mode: AttachMode,
  estimateMsValue: number,
  createdAtMs: number,
  settledAtMs: number,
  leaderRunMs: number | null,
): ServedSavings => {
  const estimateMs = nonNegativeMs(estimateMsValue);
  let compute: Pick<ServedSavings, 'savedComputeMs' | 'savedComputeSource'>;
  switch (mode) {
    case 'identity':
      compute =
        leaderRunMs === null
          ? { savedComputeMs: estimateMs, savedComputeSource: 'estimate' }
          : { savedComputeMs: nonNegativeMs(leaderRunMs), savedComputeSource: 'exact' };
      break;
    case 'coverage': {
      if (leaderRunMs === null) {
        compute = { savedComputeMs: estimateMs, savedComputeSource: 'estimate' };
        break;
      }
      const measuredLeaderMs = nonNegativeMs(leaderRunMs);
      const bounded = Math.min(estimateMs, measuredLeaderMs);
      compute = {
        savedComputeMs: bounded,
        savedComputeSource: bounded === measuredLeaderMs ? 'exact' : 'estimate',
      };
      break;
    }
    case 'batch':
      compute = { savedComputeMs: estimateMs, savedComputeSource: 'estimate' };
      break;
    default: {
      const exhaustive: never = mode;
      return exhaustive;
    }
  }
  return {
    ...compute,
    savedLatencyMs: Math.round(estimateMs - (settledAtMs - createdAtMs)),
  };
};
