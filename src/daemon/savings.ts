import type { AttachMode, SavedComputeSource } from './protocol.js';

export interface ServedSavings {
  readonly savedComputeMs: number;
  readonly savedComputeSource: SavedComputeSource;
  readonly savedLatencyMs: number;
}

export const nonNegativeMs = (value: number): number => Math.max(0, Math.round(value));

/**
 * When the rider's own cargo could have started at the earliest. A rider
 * attaches inside the leader's lane, behind or beside it, so its solo run
 * could not have begun before the leader's did: time spent queued behind a
 * not-yet-started leader is lane wait the rider would have paid either way,
 * never a cost of attaching. A leader that had not started by settlement
 * (killed while queued) leaves the rider's own creation as the origin.
 */
export const riddenFromMs = (createdAtMs: number, leaderStartedAtMs: number | null): number =>
  leaderStartedAtMs === null ? createdAtMs : Math.max(createdAtMs, leaderStartedAtMs);

/**
 * Counterfactual credit for one request served by another cargo process.
 * Compute is what the rider's own process would have burned. Latency
 * compares the rider's estimated solo run, starting at `riddenFromMs`,
 * with the time it actually spent riding; it stays signed, so a rider whose
 * leader ran longer than the rider's own run would have shows the regression
 * rather than hiding it.
 */
export const calculateServedSavings = (
  mode: AttachMode,
  estimateMsValue: number,
  createdAtMs: number,
  settledAtMs: number,
  leaderRunMs: number | null,
  leaderStartedAtMs: number | null = null,
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
  const riddenMs = Math.max(0, settledAtMs - riddenFromMs(createdAtMs, leaderStartedAtMs));
  return {
    ...compute,
    savedLatencyMs: Math.round(estimateMs - riddenMs),
  };
};
