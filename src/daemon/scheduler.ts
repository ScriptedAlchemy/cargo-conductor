/**
 * Pure lane-scheduling policy. Lower score runs first:
 *
 *   score = estimateMs * editFactor * switchFactor / ((1 + waiters) * (1 + ageMs / 30s))
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
 * - Surface affinity: a candidate whose compile surface (profile, features,
 *   target, toolchain, environment) differs from the one the lane just built
 *   is scored as 1.5× its estimate. Switching surfaces re-links or rebuilds
 *   the crate under test; the ledger showed such runs taking 1.6–2.5× as
 *   long as same-surface runs while 47% of consecutive leaders switched. So
 *   the lane groups like with like unless the switch is clearly cheaper.
 * - Age escape: waiting 30s halves the effective score, so a broad workspace
 *   build cannot be starved forever by a stream of quick checks.
 */

/** Estimate multiplier for a candidate that would change the lane's compile surface. */
export const surfaceSwitchFactor = 1.5;

import { parseCargoArgv } from './intent-normalizer.js';
import type { ParsedCargoArgv } from './intent-normalizer.js';
import type { AdmissionDeferReason, AdmissionHold } from './protocol.js';

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
  /**
   * True when the lane last built a different compile surface than this
   * candidate's; false when they match or the lane has built nothing yet.
   */
  readonly surfaceSwitch?: boolean;
}

export const scheduleScore = (candidate: ScheduleCandidate): number => {
  const editFactor = candidate.editedRecently ? 0.5 : 1;
  const switchFactor = candidate.surfaceSwitch === true ? surfaceSwitchFactor : 1;
  const releaseFactor = 1 + Math.max(0, candidate.waiters) + Math.max(0, candidate.unblocks);
  const ageFactor = 1 + Math.max(0, candidate.ageMs) / 30_000;
  return (
    (Math.max(1, candidate.estimateMs) * editFactor * switchFactor) / (releaseFactor * ageFactor)
  );
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
  /** True when the candidate leader is a heavy (release/perf/workspace) build. */
  readonly heavy?: boolean;
  /** Heavy leaders currently admitted. */
  readonly heavyRunning?: number;
  /** MemAvailable below which heavy leaders are capped; null disables the cap. */
  readonly heavyMemAvailableBytes?: number | null;
  /** Heavy leaders allowed at once while the cap is active (floor 1). */
  readonly heavyMaxConcurrent?: number;
}

export type MemoryClampState = 'none' | 'soft' | 'hard';

export type AdmissionDecision =
  | { readonly defer: false }
  | { readonly defer: true; readonly reason: AdmissionDeferReason };

/** Profiles cheap enough that a stacked pair does not risk an OOM storm. */
const lightProfiles = new Set(['dev', 'test', 'check']);

type HeavyIntentShape = Pick<ParsedCargoArgv, 'profile' | 'subcommand' | 'workspace'>;

/**
 * Release/perf/bench-style profiles and workspace-wide invocations: the
 * builds whose rustc RSS stacks into the OOM kill storms the cap prevents.
 */
export const isHeavyIntent = (intent: HeavyIntentShape): boolean =>
  intent.workspace || intent.subcommand === 'bench' || !lightProfiles.has(intent.profile);

/** `isHeavyIntent` over raw argv; unparsable invocations are not heavy. */
export const isHeavyProfile = (argv: readonly string[]): boolean => {
  try {
    return isHeavyIntent(parseCargoArgv(argv));
  } catch {
    return false;
  }
};

/** True when MemAvailable is known and below the heavy-cap threshold. */
export const heavyCapActive = (
  input: Pick<AdmissionLoadInput, 'memAvailableBytes' | 'heavyMemAvailableBytes'>,
): boolean =>
  input.memAvailableBytes != null &&
  input.heavyMemAvailableBytes != null &&
  input.memAvailableBytes < input.heavyMemAvailableBytes;

const heavyCapDefers = (input: AdmissionLoadInput): boolean =>
  input.heavy === true &&
  heavyCapActive(input) &&
  (input.heavyRunning ?? 0) >= Math.max(1, input.heavyMaxConcurrent ?? 1);

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
 * Whether admission should wait for machine load to subside, and which arm
 * tripped. The clamp normally never throttles below minConcurrent running
 * builds. Hard memory pressure and the heavy-leader cap bypass that floor,
 * but the caller's bounded deadline still prevents a deadlocked queue.
 */
export const admissionDecision = (input: AdmissionLoadInput): AdmissionDecision => {
  const memClamp = memoryClampState(input);
  if (memClamp === 'hard') {
    return { defer: true, reason: 'memory-hard' };
  }
  if (heavyCapDefers(input)) {
    return { defer: true, reason: 'heavy-profile-cap' };
  }
  if (input.running < Math.max(1, input.minConcurrent)) {
    return { defer: false };
  }
  if (memClamp === 'soft') {
    return { defer: true, reason: 'memory-soft' };
  }
  if (input.loadPerCore > input.thresholdPerCore) {
    return { defer: true, reason: 'load' };
  }
  if (
    input.cpuStallPercent !== undefined &&
    input.cpuStallPercent !== null &&
    input.cpuStallThreshold !== undefined &&
    input.cpuStallThreshold !== null &&
    input.cpuStallPercent > input.cpuStallThreshold
  ) {
    return { defer: true, reason: 'cpu-stall' };
  }
  return { defer: false };
};

export const shouldDeferAdmission = (input: AdmissionLoadInput): boolean =>
  admissionDecision(input).defer;

const formatGib = (bytes: number): string => {
  const gib = bytes / 1024 ** 3;
  return `${Number.isInteger(gib) ? String(gib) : gib.toFixed(1)} GiB`;
};

/** Human-readable hold text for a deferred decision, from the same input. */
export const admissionHoldFor = (
  input: AdmissionLoadInput,
  reason: AdmissionDeferReason,
): AdmissionHold => {
  switch (reason) {
    case 'heavy-profile-cap': {
      const heavyRunning = input.heavyRunning ?? 0;
      const memory =
        input.memAvailableBytes != null && input.heavyMemAvailableBytes != null
          ? ` and MemAvailable ${formatGib(input.memAvailableBytes)} < ${formatGib(input.heavyMemAvailableBytes)}`
          : '';
      return {
        reason,
        detail: `${heavyRunning} heavy (release/perf/workspace) build${heavyRunning === 1 ? '' : 's'} already running${memory}`,
      };
    }
    case 'memory-hard':
      return { reason, detail: 'hard memory pressure (admission paused)' };
    case 'memory-soft':
      return { reason, detail: 'memory pressure (admission reduced)' };
    case 'load':
      return {
        reason,
        detail: `load ${input.loadPerCore.toFixed(2)}/core above ${input.thresholdPerCore}/core`,
      };
    case 'cpu-stall':
      return {
        reason,
        detail: `cpu stall ${input.cpuStallPercent?.toFixed(1) ?? '?'}% above ${input.cpuStallThreshold ?? '?'}%`,
      };
    default: {
      const exhaustive: never = reason;
      return exhaustive;
    }
  }
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
