import { describe, expect, it } from 'effect-rstest';

import {
  admissionDecision,
  admissionHoldFor,
  isHeavyProfile,
  scheduleScore,
  selectNextIndex,
  shouldDeferAdmission,
  type ScheduleCandidate,
} from '../src/daemon/scheduler.js';

const candidate = (overrides: Partial<ScheduleCandidate> & Pick<ScheduleCandidate, 'id'>): ScheduleCandidate => ({
  ageMs: 0,
  editedRecently: false,
  estimateMs: 120_000,
  unblocks: 0,
  waiters: 0,
  ...overrides,
});

describe('scheduleScore', () => {
  it('prefers a shorter estimate (SJF)', () => {
    const short = scheduleScore(candidate({ estimateMs: 10_000, id: 1 }));
    const long = scheduleScore(candidate({ estimateMs: 300_000, id: 2 }));
    expect(short).toBeLessThan(long);
  });

  it('divides the score by waiters so a run that unblocks more agents wins', () => {
    const lonely = scheduleScore(candidate({ id: 1, waiters: 0 }));
    const popular = scheduleScore(candidate({ id: 2, waiters: 3 }));
    expect(popular).toBeLessThan(lonely);
    expect(popular).toBeCloseTo(lonely / 4, 5);
  });

  it('counts topological unblocks like waiters, so leaves run before dependents', () => {
    // A 90s leaf check that two queued dependents are waiting on beats a
    // 60s solo job: 90s / (1 + 2) = 30s effective.
    const solo = scheduleScore(candidate({ estimateMs: 60_000, id: 1 }));
    const leaf = scheduleScore(candidate({ estimateMs: 90_000, id: 2, unblocks: 2 }));
    expect(leaf).toBeLessThan(solo);
  });

  it('halves the score when a requested package was edited recently (fail-fast)', () => {
    const stale = scheduleScore(candidate({ id: 1 }));
    const fresh = scheduleScore(candidate({ editedRecently: true, id: 2 }));
    expect(fresh).toBe(stale / 2);
  });

  it('ages waiting jobs so a broad build cannot be starved forever', () => {
    const newborn = scheduleScore(candidate({ ageMs: 0, id: 1 }));
    const aged = scheduleScore(candidate({ ageMs: 30_000, id: 2 }));
    expect(aged).toBe(newborn / 2);
  });
});

describe('selectNextIndex', () => {
  it('returns -1 for an empty candidate list', () => {
    expect(selectNextIndex([])).toBe(-1);
  });

  it('picks the lowest-score candidate and breaks ties by older (lower) id', () => {
    const candidates = [
      candidate({ estimateMs: 200_000, id: 3 }),
      candidate({ estimateMs: 10_000, id: 8 }),
      candidate({ estimateMs: 10_000, id: 2 }),
    ];
    expect(selectNextIndex(candidates)).toBe(2);
  });
});

describe('shouldDeferAdmission', () => {
  const base = { loadPerCore: 5, minConcurrent: 2, running: 3, thresholdPerCore: 2.5 };

  it('defers above the threshold once the minimum concurrency is running', () => {
    expect(shouldDeferAdmission(base)).toBe(true);
  });

  it('never throttles below the minimum concurrency, whatever the load', () => {
    expect(shouldDeferAdmission({ ...base, running: 1 })).toBe(false);
    expect(shouldDeferAdmission({ ...base, loadPerCore: 100, running: 0 })).toBe(false);
  });

  it('admits freely under the threshold', () => {
    expect(shouldDeferAdmission({ ...base, loadPerCore: 2.4 })).toBe(false);
  });

  it('floors the minimum at one running build', () => {
    expect(shouldDeferAdmission({ ...base, minConcurrent: 0, running: 1 })).toBe(true);
    expect(shouldDeferAdmission({ ...base, minConcurrent: 0, running: 0 })).toBe(false);
  });

  const memoryBase = {
    loadPerCore: 0.1,
    memAvailableBytes: 32 * 1024 ** 3,
    memAvailableMinBytes: 8 * 1024 ** 3,
    memFullAvg10: 0,
    memFullAvg60: 0,
    memHardThreshold: 20,
    memPressureLevel: null,
    memPressureLevelThreshold: null,
    memSoftThreshold: 10,
    minConcurrent: 2,
    running: 3,
    thresholdPerCore: Number.POSITIVE_INFINITY,
  };

  it('soft memory pressure defers only above the concurrency floor', () => {
    expect(shouldDeferAdmission({ ...memoryBase, memFullAvg10: 10 })).toBe(true);
    expect(
      shouldDeferAdmission({ ...memoryBase, memFullAvg10: 10, running: 1 }),
    ).toBe(false);
  });

  it('hard memory pressure defers regardless of the concurrency floor', () => {
    expect(
      shouldDeferAdmission({
        ...memoryBase,
        memFullAvg10: 20,
        memFullAvg60: 10,
        running: 0,
      }),
    ).toBe(true);
    expect(
      shouldDeferAdmission({
        ...memoryBase,
        memPressureLevel: 4,
        memPressureLevelThreshold: 2,
        running: 0,
      }),
    ).toBe(true);
  });

  it('requires avg60 hysteresis before a transient PSI spike hard-blocks', () => {
    expect(
      shouldDeferAdmission({
        ...memoryBase,
        memFullAvg10: 25,
        memFullAvg60: 9.9,
        running: 0,
      }),
    ).toBe(false);
  });

  it('hard-blocks when MemAvailable falls below the configured floor', () => {
    expect(
      shouldDeferAdmission({
        ...memoryBase,
        memAvailableBytes: 8 * 1024 ** 3 - 1,
        running: 0,
      }),
    ).toBe(true);
  });

  it('maps macOS warn to soft and critical to hard', () => {
    expect(
      shouldDeferAdmission({
        ...memoryBase,
        memPressureLevel: 2,
        memPressureLevelThreshold: 2,
      }),
    ).toBe(true);
    expect(
      shouldDeferAdmission({
        ...memoryBase,
        memPressureLevel: 2,
        memPressureLevelThreshold: 4,
      }),
    ).toBe(false);
  });

  it('disables memory arms when knobs or signals are null', () => {
    expect(
      shouldDeferAdmission({
        ...memoryBase,
        memAvailableBytes: 1,
        memAvailableMinBytes: null,
        memFullAvg10: 100,
        memFullAvg60: 100,
        memHardThreshold: null,
        memSoftThreshold: null,
      }),
    ).toBe(false);
    expect(
      shouldDeferAdmission({
        ...memoryBase,
        memAvailableBytes: null,
        memFullAvg10: null,
        memFullAvg60: null,
      }),
    ).toBe(false);
  });
});

describe('isHeavyProfile', () => {
  it('marks release, perf/custom profiles, bench, and workspace-wide runs as heavy', () => {
    expect(isHeavyProfile(['cargo', 'build', '--release'])).toBe(true);
    expect(isHeavyProfile(['cargo', 'test', '-r', '-p', 'core'])).toBe(true);
    expect(isHeavyProfile(['cargo', 'build', '--profile', 'perf'])).toBe(true);
    expect(isHeavyProfile(['cargo', 'build', '--profile=release'])).toBe(true);
    expect(isHeavyProfile(['cargo', 'build', '--profile', 'bench'])).toBe(true);
    expect(isHeavyProfile(['cargo', 'bench', '-p', 'core'])).toBe(true);
    expect(isHeavyProfile(['cargo', 'check', '--workspace'])).toBe(true);
    expect(isHeavyProfile(['cargo', 'clippy', '--all'])).toBe(true);
  });

  it('leaves dev, test, and check profiles scoped to packages as light', () => {
    expect(isHeavyProfile(['cargo', 'check', '-p', 'core'])).toBe(false);
    expect(isHeavyProfile(['cargo', 'build'])).toBe(false);
    expect(isHeavyProfile(['cargo', 'test', '-p', 'core'])).toBe(false);
    expect(isHeavyProfile(['cargo', 'build', '--profile', 'dev'])).toBe(false);
    expect(isHeavyProfile(['cargo', 'build', '--profile=test'])).toBe(false);
    expect(isHeavyProfile(['cargo', 'build', '--profile', 'check'])).toBe(false);
    expect(isHeavyProfile(['cargo', 'build', '--release', '--debug'])).toBe(false);
  });

  it('never throws on unparsable invocations', () => {
    expect(isHeavyProfile([])).toBe(false);
    expect(isHeavyProfile(['cargo'])).toBe(false);
    expect(isHeavyProfile(['cargo', 'build', '--profile'])).toBe(false);
  });
});

describe('heavy-profile cap', () => {
  const gib = 1024 ** 3;
  const base = {
    heavy: true,
    heavyMaxConcurrent: 1,
    heavyMemAvailableBytes: 16 * gib,
    heavyRunning: 1,
    loadPerCore: 0.1,
    memAvailableBytes: 11.2 * gib,
    memAvailableMinBytes: 8 * gib,
    minConcurrent: 2,
    running: 1,
    thresholdPerCore: Number.POSITIVE_INFINITY,
  };

  it('defers a second heavy leader below the threshold, bypassing the concurrency floor', () => {
    expect(admissionDecision(base)).toEqual({ defer: true, reason: 'heavy-profile-cap' });
    expect(shouldDeferAdmission(base)).toBe(true);
  });

  it('admits non-heavy leaders and heavy leaders under the cap', () => {
    expect(admissionDecision({ ...base, heavy: false })).toEqual({ defer: false });
    expect(admissionDecision({ ...base, heavyRunning: 0 })).toEqual({ defer: false });
    expect(admissionDecision({ ...base, heavyMaxConcurrent: 2 })).toEqual({ defer: false });
    expect(admissionDecision({ ...base, heavyMaxConcurrent: 2, heavyRunning: 2 })).toEqual({
      defer: true,
      reason: 'heavy-profile-cap',
    });
  });

  it('does not cap when MemAvailable is at or above the threshold', () => {
    expect(admissionDecision({ ...base, memAvailableBytes: 16 * gib })).toEqual({ defer: false });
    expect(admissionDecision({ ...base, memAvailableBytes: 40 * gib })).toEqual({ defer: false });
  });

  it('fails open when MemAvailable is unknown', () => {
    expect(admissionDecision({ ...base, memAvailableBytes: null })).toEqual({ defer: false });
    expect(admissionDecision({ ...base, memAvailableBytes: undefined })).toEqual({ defer: false });
  });

  it('is disabled by a null threshold', () => {
    expect(admissionDecision({ ...base, heavyMemAvailableBytes: null })).toEqual({ defer: false });
  });

  it('still hard-blocks everything below the MemAvailable floor', () => {
    expect(admissionDecision({ ...base, heavy: false, memAvailableBytes: 7 * gib })).toEqual({
      defer: true,
      reason: 'memory-hard',
    });
  });

  it('explains the hold in GiB with the heavy count', () => {
    expect(admissionHoldFor(base, 'heavy-profile-cap')).toEqual({
      reason: 'heavy-profile-cap',
      detail:
        '1 heavy (release/perf/workspace) build already running and MemAvailable 11.2 GiB < 16 GiB',
    });
    expect(admissionHoldFor({ ...base, heavyRunning: 2 }, 'heavy-profile-cap').detail).toBe(
      '2 heavy (release/perf/workspace) builds already running and MemAvailable 11.2 GiB < 16 GiB',
    );
  });

  it('reports the tripped arm for the other deferrals', () => {
    const loaded = { loadPerCore: 5, minConcurrent: 2, running: 3, thresholdPerCore: 2.5 };
    expect(admissionDecision(loaded)).toEqual({ defer: true, reason: 'load' });
    expect(admissionHoldFor(loaded, 'load').detail).toBe('load 5.00/core above 2.5/core');
    expect(
      admissionDecision({ ...loaded, loadPerCore: 0, cpuStallPercent: 80, cpuStallThreshold: 75 }),
    ).toEqual({ defer: true, reason: 'cpu-stall' });
    expect(
      admissionDecision({ ...loaded, loadPerCore: 0, memFullAvg10: 12, memSoftThreshold: 10 }),
    ).toEqual({ defer: true, reason: 'memory-soft' });
  });
});

describe('surface affinity', () => {
  it('scores a candidate on another compile surface as 1.5x its estimate', () => {
    const same = scheduleScore(candidate({ id: 1, surfaceSwitch: false }));
    const switching = scheduleScore(candidate({ id: 2, surfaceSwitch: true }));
    const unknown = scheduleScore(candidate({ id: 3 }));
    expect(switching).toBeCloseTo(same * 1.5, 6);
    expect(unknown).toBe(same);
  });

  it('keeps the lane on its current surface unless the switch is clearly cheaper', () => {
    // Equal estimates: the same-surface candidate runs first even though the
    // switching one arrived earlier.
    expect(
      selectNextIndex([
        candidate({ id: 1, surfaceSwitch: true }),
        candidate({ id: 2, surfaceSwitch: false }),
      ]),
    ).toBe(1);
    // A switch that is half the work still wins: shortest-job-first is not
    // overridden by affinity, only weighted.
    expect(
      selectNextIndex([
        candidate({ estimateMs: 60_000, id: 1, surfaceSwitch: true }),
        candidate({ estimateMs: 120_000, id: 2, surfaceSwitch: false }),
      ]),
    ).toBe(0);
    // Age escape still applies to a switching candidate.
    expect(
      selectNextIndex([
        candidate({ ageMs: 60_000, id: 1, surfaceSwitch: true }),
        candidate({ id: 2, surfaceSwitch: false }),
      ]),
    ).toBe(0);
  });
});
