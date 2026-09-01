import { Effect, Schedule, Stream, type Duration } from 'effect';

import { cargoJsonDemuxFlag, namedPackagesInArgv } from '../src/lib/argv.js';
import { packageVersion } from '../src/lib/version.js';

/**
 * Pure logic for the dashboard widget, kept DOM-free so unit tests can import
 * it directly (the widget entry touches `document` at module scope).
 */

export const DEMUX_FLAG = cargoJsonDemuxFlag;
export const dashboardVersion = packageVersion;

/**
 * Statuses a request can end in. Denied is terminal too — a hook-blocked
 * invocation is finished work the operator should see in History, rendered
 * distinctly from failed (cargo ran and errored) and killed (stopped by
 * request), not blended into either.
 */
export const terminalStatuses: ReadonlySet<string> = new Set([
  'done',
  'failed',
  'killed',
  'denied',
  'passthrough',
]);

export type DashboardSection =
  | 'contention'
  | 'inFlight'
  | 'queue'
  | 'metrics'
  | 'kache'
  | 'lanes'
  | 'history';

/**
 * Fixed section order regardless of content. Sections used to unmount when
 * empty, but on a live-polling page that made the layout jump every time work
 * started or finished; instead every section stays mounted and empty ones
 * render a slim one-line state.
 */
export const sectionOrder: readonly DashboardSection[] = [
  'contention',
  'inFlight',
  'queue',
  'metrics',
  'kache',
  'lanes',
  'history',
];

/** One dashboard polling emission: the last good status plus this poll's outcome. */
export interface StatusPoll<A> {
  /** Latest successfully fetched status, held across failed polls. */
  readonly value: A | null;
  /** Failure message of the most recent poll; null when it succeeded. */
  readonly error: string | null;
  /** Wall-clock ms of the last successful poll; null before the first. */
  readonly updatedAtMs: number | null;
}

type PollOutcome<A> =
  | { readonly _tag: 'Ok'; readonly value: A }
  | { readonly _tag: 'Err'; readonly message: string };

/**
 * Polls `fetch` on a fixed cadence forever. One rejected or timed-out
 * iteration must not terminate the stream — `Stream.fromEffectSchedule`
 * over a failing effect ends the stream, freezing the widget on stale data
 * until a manual Retry — so each poll is folded into a {@link StatusPoll}
 * that keeps the last good value and carries the error alongside it while
 * the cadence continues.
 */
export const pollStatus = <A, E, R>(
  fetch: Effect.Effect<A, E, R>,
  options: {
    readonly describeError: (error: E) => string;
    readonly interval: Duration.Input;
    readonly nowMs?: () => number;
  },
): Stream.Stream<StatusPoll<A>, never, R> => {
  const now = options.nowMs ?? Date.now;
  const attempt = fetch.pipe(
    Effect.match({
      onFailure: (error): PollOutcome<A> => ({ _tag: 'Err', message: options.describeError(error) }),
      onSuccess: (value): PollOutcome<A> => ({ _tag: 'Ok', value }),
    }),
  );
  return Stream.fromEffectSchedule(attempt, Schedule.spaced(options.interval)).pipe(
    Stream.mapAccum(
      (): StatusPoll<A> => ({ error: null, updatedAtMs: null, value: null }),
      (state, outcome) => {
        switch (outcome._tag) {
          case 'Ok': {
            const next: StatusPoll<A> = { error: null, updatedAtMs: now(), value: outcome.value };
            return [next, [next]] as const;
          }
          case 'Err': {
            const next: StatusPoll<A> = { ...state, error: outcome.message };
            return [next, [next]] as const;
          }
          default: {
            const exhaustive: never = outcome;
            return exhaustive;
          }
        }
      },
    ),
  );
};

export interface RunHistogramShape {
  readonly buckets?: unknown;
  readonly count?: unknown;
  readonly min?: unknown;
  readonly max?: unknown;
  readonly sum?: unknown;
}

/**
 * Below this run count the p95 column is hidden: on a tiny histogram the 95th
 * percentile is just "the slowest run so far" dressed up as a distribution
 * (a real n=3 dashboard showed p50 = p95 = the same bucket ceiling).
 */
export const percentileMinSamples = 10;

export const metricsWindowIds = ['hour', 'day', 'all'] as const;
export type MetricsWindowId = (typeof metricsWindowIds)[number];
export const defaultMetricsWindowId: MetricsWindowId = 'day';

export interface DashboardMetricsWindowBySubcommand {
  readonly subcommand: string;
  readonly count: number;
  readonly p50Ms: number | null;
  readonly maxMs: number | null;
}

export interface DashboardMetricsWindow {
  readonly id: MetricsWindowId;
  readonly count: number;
  readonly done: number;
  readonly failed: number;
  readonly killed: number;
  readonly runP50Ms: number | null;
  readonly runP95Ms: number | null;
  readonly runMeanMs: number | null;
  readonly waitP50Ms: number | null;
  readonly waitP95Ms: number | null;
  readonly bySubcommand: readonly DashboardMetricsWindowBySubcommand[];
}

export interface PickedMetricsWindow {
  readonly id: MetricsWindowId;
  readonly source: 'ledger-windows' | 'daemon-lifetime';
  readonly window: DashboardMetricsWindow | null;
}

export const pickMetricsWindow = (
  windows: readonly DashboardMetricsWindow[] | undefined,
  selectedId: MetricsWindowId,
): PickedMetricsWindow => {
  if (windows === undefined || windows.length === 0) {
    return { id: selectedId, source: 'daemon-lifetime', window: null };
  }
  const selected = windows.find((window) => window.id === selectedId);
  if (selected !== undefined) {
    return { id: selected.id, source: 'ledger-windows', window: selected };
  }
  const fallback = windows.find((window) => window.id === defaultMetricsWindowId) ?? windows[0];
  return { id: fallback.id, source: 'ledger-windows', window: fallback };
};

export const metricsWindowLabel = (id: MetricsWindowId): string => {
  switch (id) {
    case 'hour':
      return '1h';
    case 'day':
      return '24h';
    case 'all':
      return 'all';
    default: {
      const exhaustive: never = id;
      return exhaustive;
    }
  }
};

/** Upper-bound estimate of the given percentile from histogram buckets ([le, cumulativeCount]). */
export const histogramPercentile = (
  histogram: RunHistogramShape,
  percentile: number,
): number | null => {
  const count = typeof histogram.count === 'number' ? histogram.count : 0;
  if (count === 0 || !Array.isArray(histogram.buckets)) {
    return null;
  }
  const target = count * percentile;
  for (const bucket of histogram.buckets) {
    if (!Array.isArray(bucket)) {
      continue;
    }
    const le: unknown = bucket[0];
    const cumulative: unknown = bucket[1];
    if (typeof le === 'number' && typeof cumulative === 'number' && cumulative >= target) {
      return le;
    }
  }
  return typeof histogram.max === 'number' ? histogram.max : null;
};

export interface RunMetricsView {
  readonly count: number;
  readonly meanMs: number | null;
  readonly p50Ms: number | null;
  /** null until the histogram reaches {@link percentileMinSamples} runs. */
  readonly p95Ms: number | null;
}

export const runMetricsView = (runs: RunHistogramShape | undefined): RunMetricsView => {
  const count = typeof runs?.count === 'number' ? runs.count : 0;
  if (runs === undefined || count === 0) {
    return { count, meanMs: null, p50Ms: null, p95Ms: null };
  }
  return {
    count,
    meanMs: typeof runs.sum === 'number' ? runs.sum / count : null,
    p50Ms: histogramPercentile(runs, 0.5),
    p95Ms: count >= percentileMinSamples ? histogramPercentile(runs, 0.95) : null,
  };
};

export interface WaitSummaryShape {
  readonly count?: unknown;
  readonly max?: unknown;
  readonly quantiles?: unknown;
}

export interface WaitMetricsView {
  readonly source: 'daemon-1h' | 'visible-window';
  readonly count: number;
  readonly p50Ms: number | null;
  readonly p90Ms: number | null;
  readonly p95Ms: number | null;
  readonly maxMs: number | null;
}

const summaryQuantile = (summary: WaitSummaryShape, target: number): number | null => {
  if (!Array.isArray(summary.quantiles)) {
    return null;
  }
  for (const entry of summary.quantiles) {
    if (!Array.isArray(entry) || entry.length !== 2) {
      continue;
    }
    const quantile = entry[0];
    const value = entry[1];
    if (typeof quantile === 'number' && quantile === target) {
      return typeof value === 'number' ? value : null;
    }
  }
  return null;
};

export const waitMetricsView = (
  summary: WaitSummaryShape | undefined,
  waits: readonly number[],
): WaitMetricsView => {
  if (summary !== undefined && typeof summary.count === 'number' && summary.count >= 0) {
    return {
      source: 'daemon-1h',
      count: summary.count,
      p50Ms: summaryQuantile(summary, 0.5),
      p90Ms: summaryQuantile(summary, 0.9),
      p95Ms: summaryQuantile(summary, 0.95),
      maxMs: typeof summary.max === 'number' ? summary.max : null,
    };
  }
  const sorted = [...waits].sort((left, right) => left - right);
  return {
    source: 'visible-window',
    count: sorted.length,
    p50Ms: sorted.length === 0 ? null : sorted[Math.floor((sorted.length - 1) * 0.5)],
    p90Ms: null,
    p95Ms: null,
    maxMs: sorted.length === 0 ? null : sorted[sorted.length - 1],
  };
};

/** Entries of a frequency metric with zero and non-numeric counts dropped. */
export const frequencyEntries = (
  record: Readonly<Record<string, unknown>> | undefined,
): readonly (readonly [string, number])[] =>
  record === undefined
    ? []
    : Object.entries(record).filter(
        (entry): entry is [string, number] => typeof entry[1] === 'number' && entry[1] > 0,
      );

export const frequencyTotal = (record: Readonly<Record<string, unknown>> | undefined): number =>
  frequencyEntries(record).reduce((sum, [, value]) => sum + value, 0);

export interface TicketDetail {
  readonly ticket: string;
  readonly status: string;
  readonly argv: readonly string[] | null;
  readonly execArgv: readonly string[] | null;
  readonly workspaceRoot: string | null;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly runMs: number | null;
  readonly waitMs: number | null;
  readonly error: string | null;
  readonly errorCount: number | null;
  readonly warningCount: number | null;
  readonly outputTail: string | null;
  /** True when outputTail is a live in-progress snapshot from the daemon. */
  readonly outputTailLive: boolean;
  readonly diagnostics: readonly string[] | null;
}

const stringOrNull = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null;

const numberOrNull = (value: unknown): number | null =>
  typeof value === 'number' ? value : null;

const stringArrayOrNull = (value: unknown): readonly string[] | null =>
  Array.isArray(value) && value.every((part) => typeof part === 'string')
    ? (value as readonly string[])
    : null;

/** Shape a request record (status row or conductor_result payload) for the detail drawer. */
export const ticketDetailFrom = (record: unknown): TicketDetail | null => {
  if (record === null || typeof record !== 'object') {
    return null;
  }
  const row = record as Readonly<Record<string, unknown>>;
  const ticket = stringOrNull(row['ticket']);
  if (ticket === null) {
    return null;
  }
  return {
    ticket,
    status: stringOrNull(row['status']) ?? 'unknown',
    argv: stringArrayOrNull(row['argv']),
    execArgv: stringArrayOrNull(row['execArgv']),
    workspaceRoot: stringOrNull(row['workspaceRoot']),
    exitCode: numberOrNull(row['exitCode']),
    signal: stringOrNull(row['signal']),
    runMs: numberOrNull(row['runMs']),
    waitMs: numberOrNull(row['waitMs']),
    error: stringOrNull(row['error']),
    errorCount: numberOrNull(row['errorCount']),
    warningCount: numberOrNull(row['warningCount']),
    outputTail: stringOrNull(row['outputTail']),
    outputTailLive: row['outputTailLive'] === true,
    diagnostics: stringArrayOrNull(row['diagnostics']),
  };
};

/**
 * What the drawer's output pane should show. A live daemon nulls
 * `outputTail` on every status row, and even the follow-up result fetch can
 * come back tail-less; the per-diagnostic renderings the ledger kept are
 * the honest fallback before giving up with a placeholder.
 */
export const outputTextFor = (detail: TicketDetail): string | null => {
  if (detail.outputTail !== null) {
    return detail.outputTail;
  }
  if (detail.diagnostics !== null && detail.diagnostics.length > 0) {
    return detail.diagnostics.join('\n\n');
  }
  return null;
};

/**
 * Resolve the drawer detail for a clicked row. Status payloads from a running
 * daemon deliberately null `outputTail` on every row to keep the report
 * small, so a row without a tail needs one follow-up `conductor_result`
 * fetch. Finished rows receive the ledger tail; running rows receive the
 * daemon's live in-memory tail snapshot.
 */
export const resolveTicketDetail = async (
  row: unknown,
  fetchRecord: (ticket: string) => Promise<unknown>,
): Promise<TicketDetail | null> => {
  const fromRow = ticketDetailFrom(row);
  if (fromRow === null) {
    return null;
  }
  // Status rows never carry a tail. Terminal rows fetch once for the settled
  // tail; non-terminal rows must ALSO fetch — the daemon overlays a live
  // snapshot of the in-progress output onto the result record.
  if (fromRow.outputTail !== null) {
    return fromRow;
  }
  const fetched = ticketDetailFrom(await fetchRecord(fromRow.ticket));
  return fetched ?? fromRow;
};

const displayProgram = (part: string): string => {
  const slash = part.lastIndexOf('/');
  return slash === -1 ? part : part.slice(slash + 1);
};

const displayJoin = (parts: readonly string[]): string => {
  const [program, ...args] = parts;
  return program === undefined ? '' : [displayProgram(program), ...args].join(' ');
};

export const argvText = (argv: unknown): string => {
  const parts = stringArrayOrNull(argv);
  return parts === null ? '' : displayJoin(parts);
};

export const argvTitle = (argv: unknown): string => stringArrayOrNull(argv)?.join(' ') ?? '';

interface RanAs {
  readonly command: string;
  readonly extraPackages: number;
}

/**
 * What the daemon actually spawned, when it materially differs from the
 * request. The injected demux flag alone is noise and yields null; batch
 * composition (folded `-p` packages) surfaces as a "ran as" line with the
 * count of packages beyond the request's own.
 */
export const ranAsFor = (argvValue: unknown, execArgvValue: unknown): RanAs | null => {
  const argv = stringArrayOrNull(argvValue);
  const execArgv = stringArrayOrNull(execArgvValue);
  if (argv === null || execArgv === null) {
    return null;
  }
  const cleaned = execArgv.filter((part) => part !== DEMUX_FLAG);
  if (cleaned.length === argv.length && cleaned.every((part, index) => part === argv[index])) {
    return null;
  }
  const requested = namedPackagesInArgv(argv);
  let extraPackages = 0;
  for (const name of namedPackagesInArgv(cleaned)) {
    if (!requested.has(name)) {
      extraPackages += 1;
    }
  }
  return { command: displayJoin(cleaned), extraPackages };
};

export const relativeTime = (thenMs: number, nowMs: number): string => {
  const seconds = Math.round(Math.max(0, nowMs - thenMs) / 1000);
  if (seconds < 60) {
    return `${seconds}s ago`;
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  return `${Math.round(hours / 24)}d ago`;
};

export const formatMs = (ms: number): string => {
  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  }
  const seconds = ms / 1000;
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`;
  }
  // Round to whole seconds before splitting so 17m 59.6s carries to 18m
  // instead of rendering the impossible "17m 60s".
  const wholeSeconds = Math.round(seconds);
  const minutes = Math.floor(wholeSeconds / 60);
  const rest = wholeSeconds - minutes * 60;
  return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
};

/** 1536 → "1.5 KB", 1610612736 → "1.5 GB"; bytes get binary-ish 1024 steps. */
export const formatBytes = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return '—';
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? String(Math.round(value)) : value.toFixed(1)} ${units[unit]}`;
};

export const formatCompactNumber = (value: number): string => {
  const absolute = Math.abs(value);
  const unit =
    absolute >= 1_000_000_000
      ? ({ divisor: 1_000_000_000, suffix: 'b' } as const)
      : absolute >= 1_000_000
        ? ({ divisor: 1_000_000, suffix: 'm' } as const)
        : absolute >= 1_000
          ? ({ divisor: 1_000, suffix: 'k' } as const)
          : null;
  if (unit === null) {
    return String(Math.round(value));
  }
  const scaled = value / unit.divisor;
  const rounded = Math.abs(scaled) >= 10 ? Math.round(scaled) : Math.round(scaled * 10) / 10;
  return `${rounded}${unit.suffix}`;
};

/**
 * Remaining-time hint for a running row. Estimates come from prior runs of
 * the same intent, so estimate ≈ elapsed is the common steady state right
 * before finish — rendering it reads as a countdown stuck at "now" (a live
 * dashboard showed elapsed 13s with "~13s" beside it). The hint renders only
 * when the estimate exceeds elapsed by a meaningful margin: at least
 * {@link remainingMinMs} and at least {@link remainingMinFraction} of the
 * estimate. Otherwise null hides it.
 */
export const remainingMinMs = 5_000;
export const remainingMinFraction = 0.1;

export const remainingEstimateMs = (elapsedMs: number, estimateMs: unknown): number | null => {
  if (typeof estimateMs !== 'number' || estimateMs <= 0 || elapsedMs < 0) {
    return null;
  }
  const remaining = estimateMs - elapsedMs;
  return remaining >= remainingMinMs && remaining >= estimateMs * remainingMinFraction
    ? remaining
    : null;
};

/** Last path component (repo folder name); the full path belongs in the title. */
export const pathBasename = (path: string): string => {
  const segments = path.split('/').filter((segment) => segment.length > 0);
  const last = segments[segments.length - 1];
  return last === undefined ? path : last;
};

/**
 * Kache sub-panels collapse when empty, like the top-level sections: an idle
 * machine renders no "No recent heartbeats." placeholder column.
 */
export type KacheColumn = 'roots' | 'crates';

export const kacheColumns = (counts: {
  readonly roots: number;
  readonly crates: number;
}): readonly KacheColumn[] => [
  ...(counts.roots > 0 ? (['roots'] as const) : []),
  ...(counts.crates > 0 ? (['crates'] as const) : []),
];

/**
 * Kache slowest crates, grouped by build profile. Dev, release, and test
 * timings are different populations — a release build of the same crate can
 * be 10x its dev check — so crates are never ranked, and never metered,
 * across profiles: each group carries its own maximum for the meter, and
 * empty groups simply do not exist.
 */
export interface KacheCrateTiming {
  readonly crate: string;
  readonly ms: number;
}

export interface KacheProfileGroup {
  readonly profile: string;
  readonly rows: readonly KacheCrateTiming[];
  /** Group-local maximum; meters are relative to this, never a global max. */
  readonly maxMs: number;
}

/** Familiar cargo profiles lead in a stable order; anything else follows alphabetically. */
const profileOrder = ['dev', 'debug', 'release', 'test', 'bench'];

const profileRank = (profile: string): number => {
  const index = profileOrder.indexOf(profile);
  return index === -1 ? profileOrder.length : index;
};

export const kacheProfileGroups = (
  topCrates: readonly { readonly crate?: unknown; readonly profile?: unknown; readonly ms?: unknown }[],
): readonly KacheProfileGroup[] => {
  const byProfile = new Map<string, KacheCrateTiming[]>();
  for (const row of topCrates) {
    if (typeof row.crate !== 'string' || typeof row.profile !== 'string') {
      continue;
    }
    if (typeof row.ms !== 'number' || row.ms <= 0) {
      continue;
    }
    const rows = byProfile.get(row.profile) ?? [];
    rows.push({ crate: row.crate, ms: row.ms });
    byProfile.set(row.profile, rows);
  }
  return [...byProfile.entries()]
    .sort(
      ([left], [right]) =>
        profileRank(left) - profileRank(right) || left.localeCompare(right),
    )
    .map(([profile, rows]) => {
      const sorted = [...rows].sort(
        (left, right) => right.ms - left.ms || left.crate.localeCompare(right.crate),
      );
      return {
        profile,
        rows: sorted,
        maxMs: sorted.reduce((maximum, row) => Math.max(maximum, row.ms), 0),
      };
    });
};

/**
 * The cargo subcommand a row ran, for timing splits: `intentJson.subcommand`
 * (the daemon's own normalization) when present, else the first
 * non-flag/non-toolchain argv token after the program. Check and test runs
 * are different populations and must never share one histogram line.
 */
export const rowSubcommand = (row: {
  readonly intentJson?: unknown;
  readonly argv?: unknown;
}): string | null => {
  if (typeof row.intentJson === 'string' && row.intentJson.length > 0) {
    try {
      const intent: unknown = JSON.parse(row.intentJson);
      if (
        intent !== null &&
        typeof intent === 'object' &&
        typeof (intent as { subcommand?: unknown }).subcommand === 'string'
      ) {
        return (intent as { subcommand: string }).subcommand;
      }
    } catch {
      // Fall through to argv.
    }
  }
  const argv = stringArrayOrNull(row.argv);
  if (argv === null) {
    return null;
  }
  for (const part of argv.slice(1)) {
    if (part.startsWith('-') || part.startsWith('+')) {
      continue;
    }
    return part;
  }
  return null;
};

export interface SubcommandTiming {
  readonly subcommand: string;
  /** Honest n: finished rows of this subcommand inside the visible window. */
  readonly count: number;
  readonly p50Ms: number;
  readonly maxMs: number;
  readonly meanMs: number;
}

/**
 * Run timings split by subcommand, from the finished rows on screen. The
 * daemon's since-start histogram cannot be split retroactively, so this
 * window is the only place check and test can be reported as the separate
 * populations they are; each line carries its own n.
 */
export const subcommandTimings = (
  rows: readonly {
    readonly intentJson?: unknown;
    readonly argv?: unknown;
    readonly runMs?: unknown;
  }[],
): readonly SubcommandTiming[] => {
  const samples = new Map<string, number[]>();
  for (const row of rows) {
    if (typeof row.runMs !== 'number' || row.runMs < 0) {
      continue;
    }
    const subcommand = rowSubcommand(row);
    if (subcommand === null) {
      continue;
    }
    const list = samples.get(subcommand) ?? [];
    list.push(row.runMs);
    samples.set(subcommand, list);
  }
  return [...samples.entries()]
    .map(([subcommand, runs]) => {
      const sorted = [...runs].sort((left, right) => left - right);
      return {
        subcommand,
        count: sorted.length,
        p50Ms: sorted[Math.floor((sorted.length - 1) * 0.5)],
        maxMs: sorted[sorted.length - 1],
        meanMs: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
      };
    })
    .sort(
      (left, right) =>
        right.count - left.count || left.subcommand.localeCompare(right.subcommand),
    );
};

export interface SubcommandMetricsView {
  readonly source: 'daemon-lifetime' | 'visible-window';
  readonly rows: readonly SubcommandTiming[];
}

export const subcommandMetricsView = (
  byKind: Readonly<Record<string, RunHistogramShape>> | undefined,
  rows: readonly {
    readonly intentJson?: unknown;
    readonly argv?: unknown;
    readonly runMs?: unknown;
  }[],
): SubcommandMetricsView => {
  if (byKind !== undefined) {
    const fromDaemon = Object.entries(byKind)
      .map(([subcommand, histogram]): SubcommandTiming | null => {
        const count = typeof histogram.count === 'number' ? histogram.count : 0;
        if (count <= 0) {
          return null;
        }
        const maxMs = typeof histogram.max === 'number' ? histogram.max : null;
        const meanMs =
          typeof histogram.sum === 'number' && count > 0 ? histogram.sum / count : null;
        const p50Ms = histogramPercentile(histogram, 0.5);
        if (maxMs === null || meanMs === null || p50Ms === null) {
          return null;
        }
        return { subcommand, count, p50Ms, maxMs, meanMs };
      })
      .filter((row): row is SubcommandTiming => row !== null)
      .sort(
        (left, right) =>
          right.count - left.count || left.subcommand.localeCompare(right.subcommand),
      );
    return { source: 'daemon-lifetime', rows: fromDaemon };
  }
  return { source: 'visible-window', rows: subcommandTimings(rows) };
};

export interface DiagnosticBadge {
  readonly kind: 'errors' | 'warnings';
  readonly count: number;
}

/** Error/warning badges for a row; zero and unknown counts render nothing. */
export const diagnosticBadges = (
  errorCount: unknown,
  warningCount: unknown,
): readonly DiagnosticBadge[] => [
  ...(typeof errorCount === 'number' && errorCount > 0
    ? ([{ count: errorCount, kind: 'errors' }] as const)
    : []),
  ...(typeof warningCount === 'number' && warningCount > 0
    ? ([{ count: warningCount, kind: 'warnings' }] as const)
    : []),
];

/**
 * Queue wait worth surfacing on a running row. Sub-second waits are lane
 * bookkeeping, not contention; from one second up the row genuinely queued
 * before starting and the operator should see it.
 */
export const queuedWaitThresholdMs = 1_000;

export const queuedWaitMs = (waitMs: unknown): number | null =>
  typeof waitMs === 'number' && waitMs >= queuedWaitThresholdMs ? waitMs : null;

/** A lane is worth a row only while it holds work. */
export const laneIsActive = (lane: {
  readonly queued?: unknown;
  readonly runningTicket?: unknown;
}): boolean =>
  (typeof lane.queued === 'number' && lane.queued > 0) ||
  typeof lane.runningTicket === 'string';

/**
 * Time conductor's attach coalescing saved, from the rows on screen. This is
 * strictly about attached requests (identity/coverage/batch riders) — kache
 * compile timings are crate build costs, not conductor savings, and must
 * never feed this number.
 *
 * Per attached row: when its leader is visible and finished, the follower
 * skipped exactly the leader's real runtime (exact credit); otherwise the
 * follower's own prior-run estimate stands in, reported separately as
 * estimated. Batch leaders additionally fold extra `-p` packages into one
 * cargo invocation; that count is surfaced as its own signal.
 */
export interface AttachSavings {
  /** Attached rows in the window — each one is a cargo run that never spawned. */
  readonly avoidedRuns: number;
  /** Sum of finished leaders' real runMs, credited once per follower. */
  readonly savedExactMs: number;
  /** Sum of follower estimateMs where the leader's real runtime is unknown. */
  readonly savedEstimatedMs: number;
  /** Packages folded into visible leaders' batch invocations beyond their own. */
  readonly batchExtraPackages: number;
}

const isAttachMode = (value: unknown): value is 'identity' | 'coverage' | 'batch' =>
  value === 'identity' || value === 'coverage' || value === 'batch';

export const attachSavings = (
  rows: readonly {
    readonly ticket?: unknown;
    readonly attachedTo?: unknown;
    readonly attachMode?: unknown;
    readonly runMs?: unknown;
    readonly estimateMs?: unknown;
    readonly argv?: unknown;
    readonly execArgv?: unknown;
  }[],
): AttachSavings => {
  const deduped: Array<(typeof rows)[number]> = [];
  const seenTickets = new Set<string>();
  for (const row of rows) {
    if (typeof row.ticket !== 'string') {
      deduped.push(row);
      continue;
    }
    if (seenTickets.has(row.ticket)) {
      continue;
    }
    seenTickets.add(row.ticket);
    deduped.push(row);
  }
  const leadersByTicket = new Map<string, (typeof rows)[number]>();
  for (const row of deduped) {
    if (typeof row.ticket === 'string' && row.attachedTo == null) {
      leadersByTicket.set(row.ticket, row);
    }
  }
  let avoidedRuns = 0;
  let savedExactMs = 0;
  let savedEstimatedMs = 0;
  let batchExtraPackages = 0;
  for (const row of deduped) {
    if (row.attachedTo == null) {
      // Leaders (not followers) carry the batch-folded packages in execArgv.
      batchExtraPackages += ranAsFor(row.argv, row.execArgv)?.extraPackages ?? 0;
      continue;
    }
    if (typeof row.attachedTo !== 'string' || !isAttachMode(row.attachMode)) {
      continue;
    }
    avoidedRuns += 1;
    const estimateMs =
      typeof row.estimateMs === 'number' && row.estimateMs > 0 ? row.estimateMs : null;
    const leader = leadersByTicket.get(row.attachedTo);
    const leaderRunMs =
      leader !== undefined && typeof leader.runMs === 'number' && leader.runMs > 0
        ? leader.runMs
        : null;
    switch (row.attachMode) {
      case 'identity':
        if (leaderRunMs !== null) {
          savedExactMs += leaderRunMs;
        } else if (estimateMs !== null) {
          savedEstimatedMs += estimateMs;
        }
        break;
      case 'coverage':
        if (leaderRunMs !== null && estimateMs !== null) {
          const bounded = Math.min(leaderRunMs, estimateMs);
          if (bounded === leaderRunMs) {
            savedExactMs += bounded;
          } else {
            savedEstimatedMs += bounded;
          }
        } else if (leaderRunMs !== null) {
          savedExactMs += leaderRunMs;
        } else if (estimateMs !== null) {
          savedEstimatedMs += estimateMs;
        }
        break;
      case 'batch':
        if (estimateMs !== null) {
          savedEstimatedMs += estimateMs;
        }
        break;
      default: {
        const exhaustive: never = row.attachMode;
        return exhaustive;
      }
    }
  }
  return { avoidedRuns, batchExtraPackages, savedEstimatedMs, savedExactMs };
};
export const shortenPath = (path: string, maxLength = 38): string => {
  const homed = path.replace(/^\/(?:home|Users)\/[^/]+/u, '~');
  if (homed.length <= maxLength) {
    return homed;
  }
  const segments = homed.split('/').filter((segment) => segment.length > 0);
  if (segments.length <= 2) {
    return homed;
  }
  return `…/${segments.slice(-2).join('/')}`;
};
