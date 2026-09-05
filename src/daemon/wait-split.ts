import type {
  StatusMetricsHandBack,
  StatusMetricsPhaseSplit,
  StatusMetricsWaitSplit,
} from './protocol.js';

/**
 * Pure classification of leaders' queue wait (#92), fed by the ledger's
 * metrics-window scan. Kept free of SQL so the interval arithmetic is
 * testable on hand-built rows.
 *
 * A leader waits in `[queuedAt, startedAt)`. During that wait each instant
 * is attributed to exactly one cause, in this precedence:
 *
 * - lane-bound: another leader in the same lane was still compiling, i.e.
 *   between its start and its build-finished stamp (or its finish, for pure
 *   compiles and for rows older than the hand-back);
 * - permit-bound: every admission permit was held by a running leader,
 *   anywhere on the machine, and no same-lane head was compiling — a leader
 *   keeps its permit through its execution phase, so this window runs from
 *   start to finish;
 * - other: admission holds (memory, load, heavy cap), `--after`
 *   prerequisites, and scheduling latency.
 */

export interface WaitSplitRow {
  readonly id: number;
  readonly laneKey: string;
  readonly queuedAtMs: number | null;
  readonly startedAtMs: number | null;
  readonly buildFinishedAtMs: number | null;
  /** Null for a leader still running; its run is open-ended at `nowMs`. */
  readonly finishedAtMs: number | null;
}

export interface WaitSplit {
  readonly waitMs: number;
  readonly laneBoundMs: number;
  readonly permitBoundMs: number;
  readonly otherMs: number;
}

export interface ClassifyWaitsOptions {
  /** Admission permits assumed for saturation; null classifies nothing as permit-bound. */
  readonly permits: number | null;
  readonly nowMs: number;
}

/** Half-open `[from, to)`. */
interface Interval {
  readonly from: number;
  readonly to: number;
}

/** Sorted, non-overlapping union of the given intervals; empty ones are dropped. */
const mergeIntervals = (intervals: readonly Interval[]): readonly Interval[] => {
  const sorted = intervals
    .filter((interval) => interval.to > interval.from)
    .sort((left, right) => left.from - right.from || left.to - right.to);
  const merged: Interval[] = [];
  for (const interval of sorted) {
    const last = merged[merged.length - 1];
    if (last !== undefined && interval.from <= last.to) {
      if (interval.to > last.to) {
        merged[merged.length - 1] = { from: last.from, to: interval.to };
      }
      continue;
    }
    merged.push(interval);
  }
  return merged;
};

/** Milliseconds of `[from, to)` covered by a sorted disjoint interval list. */
const overlapMs = (from: number, to: number, disjoint: readonly Interval[]): number => {
  if (to <= from) {
    return 0;
  }
  // First interval that ends after `from`; everything before it cannot overlap.
  let low = 0;
  let high = disjoint.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    const candidate = disjoint[middle];
    if (candidate !== undefined && candidate.to <= from) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  let total = 0;
  for (let index = low; index < disjoint.length; index += 1) {
    const interval = disjoint[index];
    if (interval === undefined || interval.from >= to) {
      break;
    }
    total += Math.max(0, Math.min(to, interval.to) - Math.max(from, interval.from));
  }
  return total;
};

/**
 * Instants at which at least `permits` of the given runs were in flight.
 * Ends are processed before starts at equal times so back-to-back runs on
 * one permit never read as two.
 */
const saturatedIntervals = (
  runs: readonly Interval[],
  permits: number,
): readonly Interval[] => {
  if (!Number.isFinite(permits) || permits <= 0) {
    return [];
  }
  const events: { readonly atMs: number; readonly delta: 1 | -1 }[] = [];
  for (const run of runs) {
    if (run.to > run.from) {
      events.push({ atMs: run.from, delta: 1 }, { atMs: run.to, delta: -1 });
    }
  }
  events.sort((left, right) => left.atMs - right.atMs || left.delta - right.delta);
  const saturated: Interval[] = [];
  let running = 0;
  let openedAt: number | null = null;
  for (const event of events) {
    running += event.delta;
    if (openedAt === null && running >= permits) {
      openedAt = event.atMs;
    } else if (openedAt !== null && running < permits) {
      if (event.atMs > openedAt) {
        saturated.push({ from: openedAt, to: event.atMs });
      }
      openedAt = null;
    }
  }
  return mergeIntervals(saturated);
};

/**
 * Classifies every row with both a queued and a started stamp, using all
 * rows (finished or still running) as the picture of what else the machine
 * was doing. O(n log n) in the number of rows.
 */
export const classifyWaits = (
  rows: readonly WaitSplitRow[],
  options: ClassifyWaitsOptions,
): ReadonlyMap<number, WaitSplit> => {
  const runs: Interval[] = [];
  const laneHolds = new Map<string, Interval[]>();
  for (const row of rows) {
    if (row.startedAtMs === null) {
      continue;
    }
    const finishedAt = row.finishedAtMs ?? options.nowMs;
    runs.push({ from: row.startedAtMs, to: finishedAt });
    const holds = laneHolds.get(row.laneKey) ?? [];
    holds.push({ from: row.startedAtMs, to: row.buildFinishedAtMs ?? finishedAt });
    laneHolds.set(row.laneKey, holds);
  }
  const laneUnions = new Map<string, readonly Interval[]>();
  for (const [laneKey, holds] of laneHolds) {
    laneUnions.set(laneKey, mergeIntervals(holds));
  }
  const saturated =
    options.permits === null ? [] : saturatedIntervals(runs, options.permits);

  const splits = new Map<number, WaitSplit>();
  for (const row of rows) {
    if (row.queuedAtMs === null || row.startedAtMs === null) {
      continue;
    }
    const from = row.queuedAtMs;
    const to = row.startedAtMs;
    const waitMs = Math.max(0, to - from);
    if (waitMs === 0) {
      splits.set(row.id, { laneBoundMs: 0, otherMs: 0, permitBoundMs: 0, waitMs });
      continue;
    }
    const lane = laneUnions.get(row.laneKey) ?? [];
    const laneBoundMs = overlapMs(from, to, lane);
    let permitBoundMs = 0;
    for (const interval of saturated) {
      const pieceFrom = Math.max(from, interval.from);
      const pieceTo = Math.min(to, interval.to);
      if (pieceTo <= pieceFrom) {
        continue;
      }
      permitBoundMs += pieceTo - pieceFrom - overlapMs(pieceFrom, pieceTo, lane);
    }
    splits.set(row.id, {
      laneBoundMs,
      otherMs: Math.max(0, waitMs - laneBoundMs - permitBoundMs),
      permitBoundMs,
      waitMs,
    });
  }
  return splits;
};

/** Nearest-rank percentile of an ascending list; null when empty. */
export const sortedPercentile = (sorted: readonly number[], percentile: number): number | null =>
  sorted.length === 0 ? null : (sorted[Math.floor((sorted.length - 1) * percentile)] ?? null);

export const sumWaitSplits = (
  splits: Iterable<WaitSplit>,
  permits: number | null,
): StatusMetricsWaitSplit => {
  let count = 0;
  let laneBoundMs = 0;
  let permitBoundMs = 0;
  let otherMs = 0;
  for (const split of splits) {
    count += 1;
    laneBoundMs += split.laneBoundMs;
    permitBoundMs += split.permitBoundMs;
    otherMs += split.otherMs;
  }
  return { count, laneBoundMs, otherMs, permitBoundMs, permits };
};

export interface PhaseSample {
  readonly compileMs: number;
  readonly executeMs: number;
}

/** Compile and execution durations of a leader that handed its lane back; null without the stamp. */
export const phaseSample = (
  row: Pick<WaitSplitRow, 'startedAtMs' | 'buildFinishedAtMs' | 'finishedAtMs'>,
): PhaseSample | null => {
  if (
    row.startedAtMs === null ||
    row.buildFinishedAtMs === null ||
    row.finishedAtMs === null ||
    row.buildFinishedAtMs < row.startedAtMs ||
    row.finishedAtMs < row.buildFinishedAtMs
  ) {
    return null;
  }
  return {
    compileMs: row.buildFinishedAtMs - row.startedAtMs,
    executeMs: row.finishedAtMs - row.buildFinishedAtMs,
  };
};

export const summarizePhases = (
  samples: readonly PhaseSample[],
): StatusMetricsPhaseSplit | null => {
  if (samples.length === 0) {
    return null;
  }
  const compile = samples.map((sample) => sample.compileMs).sort((left, right) => left - right);
  const execute = samples.map((sample) => sample.executeMs).sort((left, right) => left - right);
  return {
    count: samples.length,
    compileP50Ms: sortedPercentile(compile, 0.5),
    executeP50Ms: sortedPercentile(execute, 0.5),
    compileTotalMs: compile.reduce((sum, value) => sum + value, 0),
    executeTotalMs: execute.reduce((sum, value) => sum + value, 0),
  };
};

/** Lane time the hand-back released: every execution phase ran with the lane already free. */
export const summarizeHandBack = (samples: readonly PhaseSample[]): StatusMetricsHandBack => ({
  leaders: samples.length,
  laneReleasedMs: samples.reduce((sum, sample) => sum + sample.executeMs, 0),
});
