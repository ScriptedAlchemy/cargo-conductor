import { describe, expect, it } from '@rstest/core';

import { scheduleScore, selectNextIndex, type ScheduleCandidate } from '../src/daemon/scheduler.js';

const candidate = (overrides: Partial<ScheduleCandidate> & Pick<ScheduleCandidate, 'id'>): ScheduleCandidate => ({
  ageMs: 0,
  editedRecently: false,
  estimateMs: 120_000,
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
