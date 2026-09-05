import { describe, expect, it } from 'effect-rstest';

import {
  classifyWaits,
  phaseSample,
  sortedPercentile,
  summarizeHandBack,
  summarizePhases,
  sumWaitSplits,
} from '../src/daemon/wait-split.js';
import type { WaitSplitRow } from '../src/daemon/wait-split.js';

const row = (
  id: number,
  laneKey: string,
  stamps: {
    readonly queued?: number | null;
    readonly started: number | null;
    readonly buildFinished?: number | null;
    readonly finished: number | null;
  },
): WaitSplitRow => ({
  id,
  laneKey,
  queuedAtMs: stamps.queued === undefined ? stamps.started : stamps.queued,
  startedAtMs: stamps.started,
  buildFinishedAtMs: stamps.buildFinished ?? null,
  finishedAtMs: stamps.finished,
});

const nowMs = 100_000;

describe('classifyWaits', () => {
  it('charges the wait behind a same-lane compile to the lane, up to the hand-back', () => {
    const splits = classifyWaits(
      [
        // Head compiles 0–400 then executes 400–600; the lane is free from 400.
        row(1, 'lane-a', { started: 0, buildFinished: 400, finished: 600 }),
        row(2, 'lane-a', { queued: 100, started: 400, finished: 500 }),
      ],
      { nowMs, permits: 8 },
    );
    expect(splits.get(2)).toEqual({ laneBoundMs: 300, otherMs: 0, permitBoundMs: 0, waitMs: 300 });
    expect(splits.get(1)).toEqual({ laneBoundMs: 0, otherMs: 0, permitBoundMs: 0, waitMs: 0 });
  });

  it('treats a head without a hand-back stamp as compiling until it finishes', () => {
    const splits = classifyWaits(
      [
        row(1, 'lane-a', { started: 0, finished: 600 }),
        row(2, 'lane-a', { queued: 100, started: 600, finished: 700 }),
      ],
      { nowMs, permits: 8 },
    );
    expect(splits.get(2)).toEqual({ laneBoundMs: 500, otherMs: 0, permitBoundMs: 0, waitMs: 500 });
  });

  it('charges waits in an idle lane to permits while every permit is held', () => {
    const splits = classifyWaits(
      [
        row(1, 'lane-a', { started: 0, finished: 1_000 }),
        row(2, 'lane-b', { started: 0, buildFinished: 200, finished: 1_000 }),
        // lane-c is idle; both permits stay held (execution keeps a permit) until 1_000.
        row(3, 'lane-c', { queued: 100, started: 1_000, finished: 1_100 }),
      ],
      { nowMs, permits: 2 },
    );
    expect(splits.get(3)).toEqual({ laneBoundMs: 0, otherMs: 0, permitBoundMs: 900, waitMs: 900 });
  });

  it('leaves admission holds and scheduling latency as other', () => {
    const splits = classifyWaits(
      [
        row(1, 'lane-a', { started: 0, finished: 100 }),
        row(2, 'lane-b', { queued: 200, started: 500, finished: 600 }),
      ],
      { nowMs, permits: 4 },
    );
    expect(splits.get(2)).toEqual({ laneBoundMs: 0, otherMs: 300, permitBoundMs: 0, waitMs: 300 });
  });

  it('gives lane precedence over permits and splits a mixed wait exactly once', () => {
    const splits = classifyWaits(
      [
        // Same-lane head compiling 0–300 (and running to 800).
        row(1, 'lane-a', { started: 0, buildFinished: 300, finished: 800 }),
        // Elsewhere, a second run keeps both permits held 0–500.
        row(2, 'lane-b', { started: 0, finished: 500 }),
        // Waits 100–700: lane 100–300, permits 300–500, other 500–700.
        row(3, 'lane-a', { queued: 100, started: 700, finished: 900 }),
      ],
      { nowMs, permits: 2 },
    );
    expect(splits.get(3)).toEqual({
      laneBoundMs: 200,
      otherMs: 200,
      permitBoundMs: 200,
      waitMs: 600,
    });
  });

  it('counts leaders still running as open until now, and classifies no permit wait without a count', () => {
    const rows = [
      row(1, 'lane-a', { started: 0, finished: null }),
      row(2, 'lane-a', { queued: 50, started: null, finished: null }),
      row(3, 'lane-b', { queued: 100, started: 900, finished: 950 }),
    ];
    const withPermits = classifyWaits(rows, { nowMs: 1_000, permits: 1 });
    expect(withPermits.has(2)).toBe(false);
    expect(withPermits.get(3)).toEqual({
      laneBoundMs: 0,
      otherMs: 0,
      permitBoundMs: 800,
      waitMs: 800,
    });
    const withoutPermits = classifyWaits(rows, { nowMs: 1_000, permits: null });
    expect(withoutPermits.get(3)).toEqual({
      laneBoundMs: 0,
      otherMs: 800,
      permitBoundMs: 0,
      waitMs: 800,
    });
  });

  it('does not read back-to-back runs on one permit as saturation', () => {
    const splits = classifyWaits(
      [
        row(1, 'lane-a', { started: 0, finished: 100 }),
        row(2, 'lane-b', { started: 100, finished: 200 }),
        row(3, 'lane-c', { queued: 0, started: 200, finished: 300 }),
      ],
      { nowMs, permits: 2 },
    );
    expect(splits.get(3)).toEqual({ laneBoundMs: 0, otherMs: 200, permitBoundMs: 0, waitMs: 200 });
  });

  it('merges overlapping lane holds so overlap is never counted twice', () => {
    const splits = classifyWaits(
      [
        row(1, 'lane-a', { started: 0, finished: 300 }),
        row(2, 'lane-a', { started: 200, finished: 500 }),
        row(3, 'lane-a', { queued: 100, started: 600, finished: 700 }),
      ],
      { nowMs, permits: null },
    );
    expect(splits.get(3)).toEqual({ laneBoundMs: 400, otherMs: 100, permitBoundMs: 0, waitMs: 500 });
  });
});

describe('sumWaitSplits', () => {
  it('totals the split across leaders and records the permit count it assumed', () => {
    const total = sumWaitSplits(
      [
        { laneBoundMs: 300, otherMs: 0, permitBoundMs: 0, waitMs: 300 },
        { laneBoundMs: 0, otherMs: 50, permitBoundMs: 200, waitMs: 250 },
      ],
      5,
    );
    expect(total).toEqual({ count: 2, laneBoundMs: 300, otherMs: 50, permitBoundMs: 200, permits: 5 });
    expect(sumWaitSplits([], null)).toEqual({
      count: 0,
      laneBoundMs: 0,
      otherMs: 0,
      permitBoundMs: 0,
      permits: null,
    });
  });
});

describe('sortedPercentile', () => {
  it('uses the ledger rank convention and is null on an empty list', () => {
    expect(sortedPercentile([], 0.5)).toBeNull();
    expect(sortedPercentile([7], 0.95)).toBe(7);
    expect(sortedPercentile([1, 2, 3, 4], 0.5)).toBe(2);
    expect(sortedPercentile(Array.from({ length: 100 }, (_, index) => index + 1), 0.95)).toBe(95);
  });
});

describe('phase split', () => {
  it('splits a handed-back leader into compile and execution and rejects impossible stamps', () => {
    expect(phaseSample({ startedAtMs: 100, buildFinishedAtMs: 400, finishedAtMs: 1_000 })).toEqual({
      compileMs: 300,
      executeMs: 600,
    });
    expect(phaseSample({ startedAtMs: 100, buildFinishedAtMs: null, finishedAtMs: 1_000 })).toBeNull();
    expect(phaseSample({ startedAtMs: 100, buildFinishedAtMs: 400, finishedAtMs: null })).toBeNull();
    expect(phaseSample({ startedAtMs: 500, buildFinishedAtMs: 400, finishedAtMs: 1_000 })).toBeNull();
    expect(phaseSample({ startedAtMs: 100, buildFinishedAtMs: 1_400, finishedAtMs: 1_000 })).toBeNull();
  });

  it('summarises phases per subcommand and the lane time the hand-back released', () => {
    const samples = [
      { compileMs: 300, executeMs: 600 },
      { compileMs: 500, executeMs: 100 },
      { compileMs: 400, executeMs: 200 },
    ];
    expect(summarizePhases(samples)).toEqual({
      count: 3,
      compileP50Ms: 400,
      executeP50Ms: 200,
      compileTotalMs: 1_200,
      executeTotalMs: 900,
    });
    expect(summarizePhases([])).toBeNull();
    // Every execution phase ran with its lane already handed to the next compile.
    expect(summarizeHandBack(samples)).toEqual({ leaders: 3, laneReleasedMs: 900 });
    expect(summarizeHandBack([])).toEqual({ leaders: 0, laneReleasedMs: 0 });
  });
});
