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
