import { namedPackagesInArgv } from '../src/lib/argv.js';
import { packageVersion } from '../src/lib/version.js';

/**
 * Pure logic for the dashboard widget, kept DOM-free so unit tests can import
 * it directly (the widget entry touches `document` at module scope).
 */

export const DEMUX_FLAG = '--message-format=json-diagnostic-rendered-ansi';
export const dashboardVersion = packageVersion;

export const terminalStatuses: ReadonlySet<string> = new Set(['done', 'failed', 'killed']);

/**
 * Sections whose presence depends on live data. Contention, Metrics, Kache,
 * and History always render (Kache additionally hides itself when the machine
 * has no kache index); In flight, Queue, and Lanes collapse entirely when
 * empty instead of rendering a "None." placeholder. When work is running,
 * In flight is the first body section, above Queue.
 */
export type DashboardSection =
  | 'contention'
  | 'inFlight'
  | 'queue'
  | 'metrics'
  | 'kache'
  | 'lanes'
  | 'history';

export interface SectionCounts {
  readonly running: number;
  readonly queued: number;
  readonly lanes: number;
}

export const sectionOrder = (counts: SectionCounts): readonly DashboardSection[] => [
  'contention',
  ...(counts.running > 0 ? (['inFlight'] as const) : []),
  ...(counts.queued > 0 ? (['queue'] as const) : []),
  'metrics',
  'kache',
  ...(counts.lanes > 0 ? (['lanes'] as const) : []),
  'history',
];

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
  };
};

/**
 * Resolve the drawer detail for a clicked row. Status payloads from a running
 * daemon deliberately null `outputTail` on every row to keep the report
 * small, so a finished row without a tail needs one follow-up
 * `conductor_result` fetch (the ledger keeps the ANSI-stripped tail). Rows
 * that already carry a tail — the stopped-daemon status path reads the ledger
 * directly — and rows still queued/running (no tail exists yet) skip the
 * fetch.
 */
export const resolveTicketDetail = async (
  row: unknown,
  fetchRecord: (ticket: string) => Promise<unknown>,
): Promise<TicketDetail | null> => {
  const fromRow = ticketDetailFrom(row);
  if (fromRow === null) {
    return null;
  }
  if (fromRow.outputTail !== null || !terminalStatuses.has(fromRow.status)) {
    return fromRow;
  }
  const fetched = ticketDetailFrom(await fetchRecord(fromRow.ticket));
  return fetched ?? fromRow;
};

const asStrings = (value: unknown): readonly string[] | null =>
  Array.isArray(value) && value.every((part) => typeof part === 'string')
    ? (value as readonly string[])
    : null;

const displayProgram = (part: string): string => {
  const slash = part.lastIndexOf('/');
  return slash === -1 ? part : part.slice(slash + 1);
};

const displayJoin = (parts: readonly string[]): string => {
  const [program, ...args] = parts;
  return program === undefined ? '' : [displayProgram(program), ...args].join(' ');
};

export const argvText = (argv: unknown): string => {
  const parts = asStrings(argv);
  return parts === null ? '' : displayJoin(parts);
};

export const argvTitle = (argv: unknown): string => asStrings(argv)?.join(' ') ?? '';

export const escapeHtml = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

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
  const argv = asStrings(argvValue);
  const execArgv = asStrings(execArgvValue);
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
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds - minutes * 60);
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
