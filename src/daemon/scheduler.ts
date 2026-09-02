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
  /** Linux PSI memory `full avg10`; null disables PSI memory admission. */
  readonly memFullAvg10?: number | null;
  /** Linux PSI memory `full avg60`, used to reject transient hard spikes. */
  readonly memFullAvg60?: number | null;
  /** Soft PSI threshold; null disables the soft memory arm. */
  readonly memSoftThreshold?: number | null;
  /** Hard PSI threshold; null disables the hard memory arm. */
  readonly memHardThreshold?: number | null;
  /** Linux MemAvailable in bytes. */
  readonly memAvailableBytes?: number | null;
  /** Hard minimum MemAvailable; null disables the availability arm. */
  readonly memAvailableMinBytes?: number | null;
  /** macOS VM pressure level (1 normal, 2 warn, 4 critical). */
  readonly memPressureLevel?: number | null;
  /** Minimum macOS level for soft admission; null disables the macOS arm. */
  readonly memPressureLevelThreshold?: number | null;
}

export type MemoryClampState = 'none' | 'soft' | 'hard';

/** Memory-only clamp state, independent of the current concurrency floor. */
export const memoryClampState = (input: AdmissionLoadInput): MemoryClampState => {
  const hardPsi =
    input.memFullAvg10 != null &&
    input.memFullAvg60 != null &&
    input.memHardThreshold != null &&
    input.memFullAvg10 >= input.memHardThreshold &&
    // Sustained storms keep avg60 elevated; requiring half the hard threshold
    // prevents a transient 10-second spike from bypassing the progress floor.
    input.memFullAvg60 >= input.memHardThreshold / 2;
  const hardAvailable =
    input.memAvailableBytes != null &&
    input.memAvailableMinBytes != null &&
    input.memAvailableBytes < input.memAvailableMinBytes;
  const hardDarwin =
    input.memPressureLevelThreshold != null && input.memPressureLevel === 4;
  if (hardPsi || hardAvailable || hardDarwin) {
    return 'hard';
  }
  const softPsi =
    input.memFullAvg10 != null &&
    input.memSoftThreshold != null &&
    input.memFullAvg10 >= input.memSoftThreshold;
  const softDarwin =
    input.memPressureLevel != null &&
    input.memPressureLevelThreshold != null &&
    input.memPressureLevel >= input.memPressureLevelThreshold;
  return softPsi || softDarwin ? 'soft' : 'none';
};

/**
 * True when admission should wait for machine load to subside. The clamp
 * normally never throttles below minConcurrent running builds. Hard memory
 * pressure bypasses that floor, but the caller's bounded deadline still
 * prevents a deadlocked queue.
 */
export const shouldDeferAdmission = (input: AdmissionLoadInput): boolean => {
  const memClamp = memoryClampState(input);
  if (memClamp === 'hard') {
    return true;
  }
  if (input.running < Math.max(1, input.minConcurrent)) {
    return false;
  }
  if (memClamp === 'soft') {
    return true;
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
