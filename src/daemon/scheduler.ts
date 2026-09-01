/**
 * Pure lane-scheduling policy. Lower score runs first:
 *
 *   score = estimateMs * editFactor / ((1 + waiters) * (1 + ageMs / 30s))
 *
 * - Shortest-job-first: cheap requests release their agents quickly (the
 *   mined traces show check p50 ~3min vs build p50 ~11min sharing one lane).
 * - Unblock fan-out: every coalesced waiter divides the score, so the run
 *   that releases the most agents wins.
 * - Topology: a candidate whose packages sit in the dependency closure of
 *   other pending requests counts them like waiters — leaves run before the
 *   crates that depend on them, unblocking more of the tree and warming the
 *   cache the dependents will reuse.
 * - Fail-fast: packages edited in the last few minutes halve the score —
 *   the request most likely to surface a fresh failure runs sooner.
 * - Age escape: waiting 30s halves the effective score, so a broad workspace
 *   build cannot be starved forever by a stream of quick checks.
 */

export interface ScheduleCandidate {
  readonly id: number;
  readonly estimateMs: number;
  readonly waiters: number;
  /**
   * Pending requests elsewhere in the lane whose dependency closure this
   * candidate compiles: running it first unblocks them (and warms the cache
   * they will hit). Weighted like waiters.
   */
  readonly unblocks: number;
  readonly ageMs: number;
  readonly editedRecently: boolean;
}

export const scheduleScore = (candidate: ScheduleCandidate): number => {
  const editFactor = candidate.editedRecently ? 0.5 : 1;
  const releaseFactor = 1 + Math.max(0, candidate.waiters) + Math.max(0, candidate.unblocks);
  const ageFactor = 1 + Math.max(0, candidate.ageMs) / 30_000;
  return (Math.max(1, candidate.estimateMs) * editFactor) / (releaseFactor * ageFactor);
};

export interface AdmissionLoadInput {
  /** 1-minute loadavg divided by available cores. */
  readonly loadPerCore: number;
  /** Builds currently holding admission permits. */
  readonly running: number;
  readonly thresholdPerCore: number;
  readonly minConcurrent: number;
  /**
   * PSI `some avg10` CPU stall percentage, when the platform provides it.
   * Loadavg is a slow 1-minute EMA that also counts uninterruptible I/O
   * waits; PSI reacts within seconds and measures actual scheduling
   * starvation, so whichever signal trips first defers admission.
   */
  readonly cpuStallPercent?: number | null;
  /** Stall percentage above which admission defers; null disables the PSI arm. */
  readonly cpuStallThreshold?: number | null;
}

/**
 * True when admission should wait for machine load to subside. The clamp
 * never throttles below minConcurrent running builds, so a loaded machine
 * still makes progress and the gate cannot deadlock the queue.
 */
export const shouldDeferAdmission = (input: AdmissionLoadInput): boolean => {
  if (input.running < Math.max(1, input.minConcurrent)) {
    return false;
  }
  if (input.loadPerCore > input.thresholdPerCore) {
    return true;
  }
  return (
    input.cpuStallPercent !== undefined &&
    input.cpuStallPercent !== null &&
    input.cpuStallThreshold !== undefined &&
    input.cpuStallThreshold !== null &&
    input.cpuStallPercent > input.cpuStallThreshold
  );
};

/** Index of the candidate to run next, or -1 when empty. Ties go to the older (lower) id. */
export const selectNextIndex = (candidates: readonly ScheduleCandidate[]): number => {
  let bestIndex = -1;
  let bestScore = Number.POSITIVE_INFINITY;
  let bestId = Number.POSITIVE_INFINITY;
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    const score = scheduleScore(candidate);
    if (score < bestScore || (score === bestScore && candidate.id < bestId)) {
      bestIndex = index;
      bestScore = score;
      bestId = candidate.id;
    }
  }
  return bestIndex;
};
