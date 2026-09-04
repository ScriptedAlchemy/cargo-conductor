/// <reference lib="dom" />
import { RegistryProvider, useAtomRefresh, useAtomSet, useAtomValue } from '@effect/atom-react';
import type { AppRouteConfig } from 'agent-bundle';
import { version as dashboardVersion } from 'agent-bundle/meta';
import { Cause, Data, Effect, Option } from 'effect';
import { AsyncResult, Atom } from 'effect/unstable/reactivity';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';

import { APP_RESOURCE_URI } from '../../../constants.js';
import {
  admissionHoldDetail,
  argvText,
  argvTitle,
  attachSavings,
  compactArgvText,
  defaultMetricsWindowId,
  delayedWaitCue,
  DEMUX_FLAG,
  diagnosticBadges,
  formatBytes,
  formatCompactNumber,
  formatMs,
  frequencyEntries,
  frequencyTotal,
  heavyAdmissionNote,
  kacheColumns,
  kacheProfileGroups,
  laneIsActive,
  metricsWindowIds,
  metricsWindowLabel,
  memoryStatView,
  outputTextFor,
  pathBasename,
  percentileMinSamples,
  pickMetricsWindow,
  pollStatus,
  queuedWaitMs,
  quietOutputHint,
  ranAsFor,
  relativeTime,
  remainingEstimateMs,
  resolveTicketDetail,
  runMetricsView,
  sectionOrder,
  shortenPath,
  stalledHint,
  subcommandDisplayLabel,
  subcommandMetricsView,
  summaryFirstLine,
  terminalStatuses,
  ticketDetailFrom,
  type RunHistogramShape,
  type DashboardMetricsWindow,
  type DashboardSection,
  type DashboardMetricsWindowBySubcommand,
  type MetricsWindowId,
  type StatusPoll,
  type TicketDetail,
  waitMetricsView,
} from '../../../dashboard/lib.js';

/**
 * Framework App-route metadata. The compiler extracts it without evaluating
 * the module, following the one relative import to read `APP_RESOURCE_URI`'s
 * string literal (`src/constants.ts` is the single source of the URI; the
 * `hauler_status` tool and the rendered skill import the same const).
 * `template` resolves beside this module, like its imports.
 */
export const config = {
  resourceUri: APP_RESOURCE_URI,
  template: './dashboard.html',
} satisfies AppRouteConfig;

interface JsonRpcMessage {
  readonly jsonrpc?: unknown;
  readonly id?: unknown;
  readonly method?: unknown;
  readonly params?: unknown;
  readonly result?: ToolCallResult;
  readonly error?: { readonly message?: unknown } | null;
}

interface ToolCallResult {
  readonly structuredContent?: StructuredContent | null;
}

interface SystemLoadShape {
  readonly loadAvg1?: unknown;
  readonly cores?: unknown;
  readonly clampThresholdPerCore?: unknown;
  readonly ioWaitPercent?: unknown;
  readonly disks?: unknown;
  readonly memAvailableBytes?: unknown;
  readonly memClamp?: unknown;
  readonly memFullAvg10?: unknown;
  readonly memPressureLevel?: unknown;
  readonly memSomeAvg10?: unknown;
  readonly heavy?: unknown;
}

interface DiskUtilShape {
  readonly device?: unknown;
  readonly utilPercent?: unknown;
}

interface StructuredContent {
  readonly summary?: unknown;
  readonly daemon?: unknown;
  readonly pid?: unknown;
  readonly maxConcurrent?: unknown;
  readonly lanes?: unknown;
  readonly active?: unknown;
  readonly recent?: unknown;
  readonly operation?: unknown;
  readonly request?: unknown;
  readonly structuredContent?: unknown;
  readonly metrics?: unknown;
  readonly savings?: unknown;
  readonly system?: unknown;
  readonly kache?: unknown;
}

interface StatusMetricsShape {
  readonly cargo_run_ms?: RunHistogramShape;
  readonly cargo_run_ms_by_kind?: Readonly<Record<string, RunHistogramShape>>;
  readonly attach_mode?: Readonly<Record<string, unknown>>;
  readonly job_outcome?: Readonly<Record<string, unknown>>;
  readonly windows?: unknown;
  readonly wait_ms_summary?: {
    readonly count?: unknown;
    readonly max?: unknown;
    readonly quantiles?: unknown;
  };
}

interface StatusMetricsWindowBySubcommandShape {
  readonly subcommand?: unknown;
  readonly profile?: unknown;
  readonly count?: unknown;
  readonly p50Ms?: unknown;
  readonly maxMs?: unknown;
}

interface StatusMetricsWindowShape {
  readonly id?: unknown;
  readonly count?: unknown;
  readonly done?: unknown;
  readonly failed?: unknown;
  readonly killed?: unknown;
  readonly runP50Ms?: unknown;
  readonly runP95Ms?: unknown;
  readonly runMeanMs?: unknown;
  readonly waitP50Ms?: unknown;
  readonly waitP95Ms?: unknown;
  readonly bySubcommand?: unknown;
}

interface SavingsModeShape {
  readonly mode?: unknown;
  readonly ridersServed?: unknown;
}

interface SavingsTotalsShape {
  readonly ridersServed?: unknown;
  readonly savedComputeMs?: unknown;
  readonly savedComputeExactMs?: unknown;
  readonly savedComputeEstimatedMs?: unknown;
  readonly savedLatencyMs?: unknown;
  readonly negativeLatencyRiders?: unknown;
}

interface SavingsShape {
  readonly byMode?: unknown;
  readonly totals?: SavingsTotalsShape;
}

interface RequestRow {
  readonly ticket?: unknown;
  readonly status?: unknown;
  readonly session?: unknown;
  readonly host?: unknown;
  readonly argv?: unknown;
  readonly execArgv?: unknown;
  readonly attachedTo?: unknown;
  readonly attachMode?: unknown;
  readonly waitMs?: unknown;
  readonly runMs?: unknown;
  readonly createdAtMs?: unknown;
  readonly startedAtMs?: unknown;
  readonly estimateMs?: unknown;
  readonly delayed?: unknown;
  readonly admissionHold?: unknown;
  readonly quietMs?: unknown;
  readonly stall?: unknown;
  readonly workspaceRoot?: unknown;
  readonly intentJson?: unknown;
  readonly errorCount?: unknown;
  readonly warningCount?: unknown;
}

interface LaneRow {
  readonly workspaceRoot?: unknown;
  readonly queued?: unknown;
  readonly runningTicket?: unknown;
}

interface KacheRootRow {
  readonly count?: unknown;
  readonly root?: unknown;
}

interface KacheTopCrateRow {
  readonly crate?: unknown;
  readonly ms?: unknown;
  readonly profile?: unknown;
}

interface KacheShape {
  readonly available?: unknown;
  readonly distinctCrates?: unknown;
  readonly entryCount?: unknown;
  readonly eventsFreshMs?: unknown;
  readonly indexSizeBytes?: unknown;
  readonly recentHeartbeatRoots?: unknown;
  readonly topCrates?: unknown;
}

interface PendingRequest {
  readonly resolve: (value: ToolCallResult) => void;
  readonly reject: (error: unknown) => void;
}

interface PushedStatus {
  readonly receivedAt: number;
  readonly value: StructuredContent;
}

interface StatusSnapshot {
  readonly timestamp: number;
  readonly value: StructuredContent | null;
}

type Initialization =
  | { readonly _tag: 'Initializing' }
  | { readonly _tag: 'Ready' }
  | { readonly _tag: 'Failed'; readonly error: Error };

const pending = new Map<number, PendingRequest>();
const pushedStatusAtom = Atom.make<PushedStatus | null>(null);
let nextId = 0;

const postMessage = (payload: Record<string, unknown>): void => {
  window.parent.postMessage(payload, '*');
};

const rpcRequest = (method: string, params: Record<string, unknown>): Promise<ToolCallResult> =>
  new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => {
      if (pending.delete(id)) {
        reject(new Error(`timed out: ${method}`));
      }
    }, 15_000);
    pending.set(id, {
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    });
    postMessage({ id, jsonrpc: '2.0', method, params });
  });

const asRecord = (value: unknown): StructuredContent | null =>
  value !== null && typeof value === 'object' ? (value as StructuredContent) : null;

const structuredFrom = (value: unknown): StructuredContent | null => {
  const record = asRecord(value);
  if (record === null) {
    return null;
  }
  const nested = asRecord(record.structuredContent);
  if (nested !== null) {
    return nested;
  }
  if (record.daemon !== undefined || record.operation === 'status' || Array.isArray(record.recent)) {
    return record;
  }
  return null;
};

class StatusRpcError extends Data.TaggedError('StatusRpcError')<{
  readonly cause: unknown;
}> {
  override get message(): string {
    return this.cause instanceof Error ? this.cause.message : String(this.cause);
  }
}

const fetchStatus = Effect.tryPromise({
  try: async () => {
    const response = await rpcRequest('tools/call', {
      arguments: { limit: 40 },
      name: 'hauler_status',
    });
    return structuredFrom(response);
  },
  catch: (cause) => new StatusRpcError({ cause }),
});

// One rejected/timed-out tools/call must not end the polling stream (the
// widget would freeze on stale data until a manual Retry): pollStatus folds
// each failure into the emitted value and keeps the 5s cadence.
export const statusAtom = Atom.make(
  pollStatus(fetchStatus, {
    describeError: (error) => error.message,
    interval: '5 seconds',
  }),
);

/**
 * Follow-up fetch for the detail drawer: status rows arrive with their
 * output tail stripped (the daemon nulls `outputTail` to keep status small),
 * while `hauler_result` reads the full ledger record, tail included.
 */
const fetchTicketRecord = async (ticketId: string): Promise<unknown> => {
  const response = await rpcRequest('tools/call', {
    arguments: { ticket: ticketId },
    name: 'hauler_result',
  });
  return asRecord(response.structuredContent)?.request ?? null;
};

const arrayOrEmpty = <T,>(value: unknown): readonly T[] => (Array.isArray(value) ? value : []);

const asMetricsWindowId = (value: unknown): MetricsWindowId | null =>
  value === 'hour' || value === 'day' || value === 'all' ? value : null;

const asDashboardWindowBySubcommand = (
  value: unknown,
): DashboardMetricsWindowBySubcommand | null => {
  const row = asRecord(value) as StatusMetricsWindowBySubcommandShape | null;
  if (
    row === null ||
    typeof row.subcommand !== 'string' ||
    (row.profile !== undefined && typeof row.profile !== 'string') ||
    typeof row.count !== 'number' ||
    (row.p50Ms !== null && typeof row.p50Ms !== 'number') ||
    (row.maxMs !== null && typeof row.maxMs !== 'number')
  ) {
    return null;
  }
  return {
    subcommand: row.subcommand,
    ...(typeof row.profile === 'string' ? { profile: row.profile } : {}),
    count: row.count,
    p50Ms: row.p50Ms ?? null,
    maxMs: row.maxMs ?? null,
  };
};

const asDashboardWindow = (value: unknown): DashboardMetricsWindow | null => {
  const row = asRecord(value) as StatusMetricsWindowShape | null;
  const id = asMetricsWindowId(row?.id);
  if (
    row === null ||
    id === null ||
    typeof row.count !== 'number' ||
    typeof row.done !== 'number' ||
    typeof row.failed !== 'number' ||
    typeof row.killed !== 'number' ||
    (row.runP50Ms !== null && typeof row.runP50Ms !== 'number') ||
    (row.runP95Ms !== null && typeof row.runP95Ms !== 'number') ||
    (row.runMeanMs !== null && typeof row.runMeanMs !== 'number') ||
    (row.waitP50Ms !== null && typeof row.waitP50Ms !== 'number') ||
    (row.waitP95Ms !== null && typeof row.waitP95Ms !== 'number') ||
    !Array.isArray(row.bySubcommand)
  ) {
    return null;
  }
  return {
    id,
    count: row.count,
    done: row.done,
    failed: row.failed,
    killed: row.killed,
    runP50Ms: row.runP50Ms ?? null,
    runP95Ms: row.runP95Ms ?? null,
    runMeanMs: row.runMeanMs ?? null,
    waitP50Ms: row.waitP50Ms ?? null,
    waitP95Ms: row.waitP95Ms ?? null,
    bySubcommand: row.bySubcommand
      .map((entry) => asDashboardWindowBySubcommand(entry))
      .filter((entry): entry is DashboardMetricsWindowBySubcommand => entry !== null),
  };
};

const dashboardWindows = (value: unknown): readonly DashboardMetricsWindow[] =>
  arrayOrEmpty(value)
    .map((entry) => asDashboardWindow(entry))
    .filter((entry): entry is DashboardMetricsWindow => entry !== null);

const duration = (value: unknown): string => (typeof value === 'number' ? formatMs(value) : '—');
const countValue = (value: unknown): string =>
  typeof value === 'number' ? formatCompactNumber(value) : '—';
const signedDuration = (value: number): string =>
  value < 0 ? `-${formatMs(Math.abs(value))}` : formatMs(value);

const ticket = (value: unknown): ReactNode =>
  value == null ? '—' : <span className="ticket">{String(value)}</span>;

// Last path component only: middle-truncated absolute paths were eating the
// distinguishing folder name; the full path lives in the title.
const workspace = (value: unknown): ReactNode =>
  typeof value !== 'string' || value.length === 0 ? (
    '—'
  ) : (
    <span className="path" title={value}>
      {pathBasename(value)}
    </span>
  );

const who = (row: RequestRow): ReactNode => {
  const host = typeof row.host === 'string' ? row.host : null;
  const session = typeof row.session === 'string' ? row.session : null;
  if (host === null && session === null) {
    return '—';
  }
  const label =
    session === null || session === host ? (host ?? '') : host === null ? session : `${host} · ${session}`;
  const title = host === null && session !== null ? `host unavailable · ${session}` : label;
  return (
    <span className="who" title={title}>
      {label}
    </span>
  );
};

/**
 * Running rows: elapsed plus a remaining hint, gated so estimate ≈ elapsed
 * never fakes a countdown, plus the queue wait when the row queued first —
 * elapsed alone understates how long the requester has been waiting.
 */
const elapsedCell = (
  sinceMs: unknown,
  estimateMs: unknown,
  waitMs: unknown,
  quietMs: unknown,
  nowMs: number,
  stall?: unknown,
  killTicket?: unknown,
): ReactNode => {
  if (typeof sinceMs !== 'number') {
    return '—';
  }
  const elapsed = Math.max(0, nowMs - sinceMs);
  const remaining = remainingEstimateMs(elapsed, estimateMs);
  const waited = queuedWaitMs(waitMs);
  const quiet = quietOutputHint(quietMs);
  const stalled = stalledHint(stall, killTicket);
  return (
    <>
      <span className="dur">{formatMs(elapsed)}</span>
      {remaining === null ? null : <span className="est"> · ~{formatMs(remaining)} left</span>}
      {waited === null ? null : (
        <span className="est" title="time spent queued before this run started">
          {' '}· waited {formatMs(waited)}
        </span>
      )}
      {quiet === null ? null : (
        <span className="est" title={quiet.title}>
          {' '}· {quiet.label}
        </span>
      )}
      {stalled === null ? null : (
        <>
          {' '}
          <span className="pill killed" title={stalled.title}>
            {stalled.label}
          </span>
        </>
      )}
    </>
  );
};

const DiagBadges = ({ row }: { readonly row: RequestRow }): ReactNode => {
  const badges = diagnosticBadges(row.errorCount, row.warningCount);
  if (badges.length === 0) {
    return null;
  }
  return (
    <>
      {badges.map((badge) => (
        <span
          className={`badge ${badge.kind === 'errors' ? 'err' : 'warn'}`}
          key={badge.kind}
          title={`${badge.count} ${badge.kind === 'errors' ? 'error' : 'warning'}${badge.count === 1 ? '' : 's'} from cargo diagnostics`}
        >
          {badge.count}{badge.kind === 'errors' ? 'E' : 'W'}
        </span>
      ))}
    </>
  );
};

const waitingCell = (
  sinceMs: unknown,
  estimateMs: unknown,
  delayed: unknown,
  admissionHold: unknown,
  nowMs: number,
): ReactNode => {
  if (typeof sinceMs !== 'number') {
    return '—';
  }
  const cue = delayedWaitCue(delayed);
  const held = admissionHoldDetail(admissionHold);
  return (
    <>
      <span className="dur">{formatMs(Math.max(0, nowMs - sinceMs))}</span>
      {typeof estimateMs === 'number' && estimateMs > 0 ? (
        <span className="est" title="expected run duration once started, from prior runs">
          {' '}· est ~{formatMs(estimateMs)}
        </span>
      ) : null}
      {held === null ? null : (
        <>
          {' '}
          <span className="pill neutral" title={`admission held: ${held}`}>
            held
          </span>
        </>
      )}
      {cue === null ? null : (
        <>
          {' '}
          <span className="pill killed" title="queued longer than its estimate threshold; the lane is busy">
            {cue}
          </span>
        </>
      )}
    </>
  );
};

const AttachChip = ({ row }: { readonly row: RequestRow }): ReactNode => {
  if (typeof row.attachedTo !== 'string') {
    return null;
  }
  const mode = typeof row.attachMode === 'string' ? ` ${row.attachMode}` : '';
  return <span className="chip">→ {row.attachedTo}{mode}</span>;
};

const CommandText = ({
  text,
  title,
}: {
  readonly text: string;
  readonly title: string;
}): ReactNode => {
  const ref = useRef<HTMLSpanElement>(null);
  const [truncated, setTruncated] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (element === null) {
      return;
    }
    const measure = (): void => {
      setTruncated(element.scrollHeight > element.clientHeight);
    };
    const frame = requestAnimationFrame(measure);
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [text]);
  return (
    <span className="cmd-wrap">
      <span className="cmd" ref={ref} title={title}>
        {text}
      </span>
      {truncated ? <span aria-hidden="true" className="cmd-truncated">… more</span> : null}
    </span>
  );
};

const Command = ({ row }: { readonly row: RequestRow }): ReactNode => {
  const ranAs = ranAsFor(row.argv, row.execArgv);
  const execArgv = Array.isArray(row.execArgv)
    ? row.execArgv.filter((part): part is string => typeof part === 'string' && part !== DEMUX_FLAG)
    : null;
  return (
    <>
      <CommandText text={compactArgvText(row.argv)} title={argvTitle(row.argv)} />
      {ranAs === null ? null : (
        <div className="ranas">
          ran as:{' '}
          <CommandText
            text={execArgv === null ? ranAs.command : compactArgvText(execArgv)}
            title={execArgv === null ? ranAs.command : argvTitle(execArgv)}
          />
          {ranAs.extraPackages > 0 ? (
            <span className="pkgcount">
              {' '}(+{ranAs.extraPackages} pkg{ranAs.extraPackages === 1 ? '' : 's'})
            </span>
          ) : null}
        </div>
      )}
    </>
  );
};

const requestCells = (row: RequestRow): readonly ReactNode[] => [
  ticket(row.ticket),
  <><Command row={row} /><DiagBadges row={row} /></>,
  workspace(row.workspaceRoot),
  who(row),
];

interface TableRowSpec {
  readonly cells: readonly ReactNode[];
  readonly onSelect?: () => void;
}

const Table = ({
  empty = 'None.',
  headers,
  numericColumns = [],
  rows,
}: {
  readonly empty?: string;
  readonly headers: readonly string[];
  readonly numericColumns?: readonly number[];
  readonly rows: readonly TableRowSpec[];
}): ReactNode => {
  if (rows.length === 0) {
    return <p className="empty">{empty}</p>;
  }
  return (
    <table>
      <thead>
        <tr>
          {headers.map((header, index) => (
            <th className={numericColumns.includes(index) ? 'numeric' : undefined} key={header}>
              {header}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, rowIndex) => (
          <tr
            className={row.onSelect === undefined ? undefined : 'selectable'}
            key={rowIndex}
            onClick={row.onSelect}
            title={row.onSelect === undefined ? undefined : 'Show cargo output'}
          >
            {row.cells.map((cell, cellIndex) => (
              <td
                className={numericColumns.includes(cellIndex) ? 'numeric' : undefined}
                key={cellIndex}
              >
                {cell}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
};

const Stat = ({
  barPercent,
  label,
  title,
  value,
}: {
  readonly barPercent?: number;
  readonly label: string;
  readonly title?: string;
  readonly value: string;
}): ReactNode => (
  <div className="stat" title={title}>
    <b>{value}</b>
    <span>{label}</span>
    {barPercent === undefined ? null : (
      <div className="mini-meter" aria-hidden="true">
        <div
          className="mini-meter-fill"
          style={{ width: `${Math.max(0, Math.min(100, barPercent))}%` }}
        />
      </div>
    )}
  </div>
);

const AdmissionMeter = ({
  heavyNote,
  maxConcurrent,
  permitHolders,
  riders,
}: {
  readonly heavyNote: string | null;
  readonly maxConcurrent: number;
  readonly permitHolders: number;
  readonly riders: number;
}): ReactNode => {
  // Riders share a leader's process: they must not read as extra permits, or
  // healthy coalescing looks like over-subscription (a real 8-rows-on-5-slots
  // sighting was 4 permits + 4 identity riders).
  const percent =
    maxConcurrent > 0 ? Math.min(100, Math.round((permitHolders / maxConcurrent) * 100)) : 0;
  return (
    <div className="stat meterstat">
      <b>
        {permitHolders}/{maxConcurrent > 0 ? maxConcurrent : '—'}
        {riders > 0 ? <span className="est"> +{riders} riding</span> : null}
        {heavyNote === null ? null : <span className="est"> · {heavyNote}</span>}
      </b>
      <span>admission</span>
      <div
        className="meter"
        title={`${permitHolders} of ${maxConcurrent} admission permits in use; ${riders} attached request${riders === 1 ? '' : 's'} riding leaders${heavyNote === null ? '' : `; ${heavyNote} (CARGO_HAULER_HEAVY_MEM_AVAILABLE_GB / CARGO_HAULER_HEAVY_MAX_CONCURRENT)`}`}
      >
        <div className="meter-fill" style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
};

const LoadStat = ({ system }: { readonly system: SystemLoadShape | null }): ReactNode => {
  if (system === null || typeof system.loadAvg1 !== 'number' || typeof system.cores !== 'number') {
    return null;
  }
  const perCore = system.cores > 0 ? system.loadAvg1 / system.cores : 0;
  const clamp =
    typeof system.clampThresholdPerCore === 'number' ? system.clampThresholdPerCore : null;
  const clamped = clamp !== null && perCore > clamp;
  const title = `1-minute load average ${system.loadAvg1.toFixed(1)} across ${system.cores} cores (${perCore.toFixed(2)}/core); ${clamp === null ? 'admission load clamp off' : `admission defers above ${clamp}/core`}`;
  return (
    <div className="stat" title={title}>
      <b>
        {system.loadAvg1.toFixed(1)}
        <span className="est"> / {system.cores} cores{clamped ? ' · clamping' : ''}</span>
      </b>
      <span>loadavg (1m) · {perCore.toFixed(2)}/core</span>
    </div>
  );
};

const MemoryStat = ({ system }: { readonly system: SystemLoadShape | null }): ReactNode => {
  const view = memoryStatView(system ?? {});
  const pressureLevel =
    typeof system?.memPressureLevel === 'number' ? system.memPressureLevel : null;
  const some =
    typeof system?.memSomeAvg10 === 'number' ? system.memSomeAvg10.toFixed(1) : 'n/a';
  const title =
    `Memory admission: soft when Linux full PSI avg10 reaches CARGO_HAULER_MEM_PRESSURE_SOFT (default 10), ` +
    `hard when full avg10 reaches CARGO_HAULER_MEM_PRESSURE_HARD (default 20) and full avg60 reaches half that threshold, ` +
    `or MemAvailable is below CARGO_HAULER_MEM_AVAILABLE_MIN_GB (default 8 GiB). ` +
    `On macOS, level 2 is soft and level 4 is hard; configured soft minimum defaults to 2. ` +
    `Current some PSI: ${some}%; macOS level: ${pressureLevel ?? 'n/a'}.`;
  return (
    <div className="stat" title={title}>
      <b>
        {view.value}
        {view.clamp === 'none' ? null : <span className="est"> · clamping</span>}
      </b>
      <span>{view.label}</span>
    </div>
  );
};

/**
 * Disk/IO pressure beside loadavg: high iowait with a modest loadavg is the
 * disk-stalled-build tell that load alone hides. The daemon only sends these
 * fields when it has an honest Linux /proc delta, so absence renders nothing
 * rather than a fabricated zero.
 */
const DiskIoStat = ({ system }: { readonly system: SystemLoadShape | null }): ReactNode => {
  const ioWait = typeof system?.ioWaitPercent === 'number' ? system.ioWaitPercent : null;
  const disks = (Array.isArray(system?.disks) ? system.disks : []).filter(
    (disk: DiskUtilShape) =>
      typeof disk.device === 'string' && typeof disk.utilPercent === 'number',
  );
  if (ioWait === null && disks.length === 0) {
    return null;
  }
  return (
    <>
      {ioWait === null ? null : (
        <div
          className="stat"
          title="share of CPU time spent waiting on disk I/O since the previous status sample; high iowait beside a modest loadavg means builds are stalled on disk, not CPU"
        >
          <b>{ioWait.toFixed(ioWait < 10 ? 1 : 0)}%</b>
          <span>iowait (cpu)</span>
        </div>
      )}
      {disks.length === 0 ? null : (
        <div
          className="stat"
          title="percent of wall time each device backing the state dir and in-flight target dirs had I/O in flight, since the previous status sample"
        >
          <b>
            {disks.map((disk, index) => (
              <span className="diskutil" key={String(disk.device)}>
                {index > 0 ? ' ' : ''}
                <span className="est">{String(disk.device)}</span>{' '}
                {Number(disk.utilPercent).toFixed(0)}%
              </span>
            ))}
          </b>
          <span>disk busy</span>
        </div>
      )}
    </>
  );
};

const StatusPill = ({ status }: { readonly status: unknown }): ReactNode => {
  const value = typeof status === 'string' && status.length > 0 ? status : 'unknown';
  return <span className={`pill ${terminalStatuses.has(value) ? value : 'neutral'}`}>{value}</span>;
};

type DrawerState =
  | { readonly _tag: 'Closed' }
  | { readonly _tag: 'Loading'; readonly detail: TicketDetail }
  | { readonly _tag: 'Loaded'; readonly detail: TicketDetail }
  | { readonly _tag: 'Failed'; readonly detail: TicketDetail; readonly message: string };

const DrawerOutput = ({ state }: { readonly state: Exclude<DrawerState, { _tag: 'Closed' }> }): ReactNode => {
  switch (state._tag) {
    case 'Loading':
      return <p className="empty">Loading output…</p>;
    case 'Failed':
      return <p className="drawer-error">Could not load output: {state.message}</p>;
    case 'Loaded': {
      // A live daemon nulls outputTail on status rows; the rendered
      // diagnostics the ledger kept are the next-best evidence.
      const text = outputTextFor(state.detail);
      if (text === null) {
        return (
          <p className="empty">
            {terminalStatuses.has(state.detail.status)
              ? 'No output was captured for this ticket.'
              : 'No output captured yet — updates live as the run produces it.'}
          </p>
        );
      }
      return (
        <>
          {state.detail.outputTailLive ? (
            <p className="live-note">live — run still in progress, output updates as it streams</p>
          ) : null}
          <pre className="output">{text}</pre>
        </>
      );
    }
    default: {
      const exhaustive: never = state;
      return exhaustive;
    }
  }
};

const TicketDrawer = ({
  onClose,
  state,
}: {
  readonly onClose: () => void;
  readonly state: DrawerState;
}): ReactNode => {
  const open = state._tag !== 'Closed';
  useEffect(() => {
    if (!open) {
      return;
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);
  if (state._tag === 'Closed') {
    return null;
  }
  const detail = state.detail;
  const counts =
    detail.errorCount === null && detail.warningCount === null
      ? null
      : `${detail.errorCount ?? 0} error${detail.errorCount === 1 ? '' : 's'} · ${detail.warningCount ?? 0} warning${detail.warningCount === 1 ? '' : 's'}`;
  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside
        aria-label={`ticket ${detail.ticket}`}
        className="drawer"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
      >
        <div className="drawer-head">
          <span className="ticket">{detail.ticket}</span>
          <StatusPill status={detail.status} />
          <button aria-label="Close" className="drawer-close" onClick={onClose} type="button">
            ✕
          </button>
        </div>
        {detail.argv === null ? null : (
          <div className="drawer-cmd" title={argvTitle(detail.argv)}>
            {argvText(detail.argv)}
          </div>
        )}
        <div className="drawer-meta">
          {detail.workspaceRoot === null ? null : workspace(detail.workspaceRoot)}
          {detail.exitCode === null ? null : <span className="chip">exit {detail.exitCode}</span>}
          {detail.signal === null ? null : <span className="chip">signal {detail.signal}</span>}
          {detail.runMs === null ? null : <span className="chip">ran {formatMs(detail.runMs)}</span>}
          {detail.waitMs === null ? null : <span className="chip">waited {formatMs(detail.waitMs)}</span>}
          {counts === null ? null : <span className="chip">{counts}</span>}
        </div>
        {detail.error === null ? null : <div className="drawer-error">{detail.error}</div>}
        <DrawerOutput state={state} />
      </aside>
    </div>
  );
};

const frequencyText = (entries: readonly (readonly [string, number])[]): string =>
  entries.map(([key, value]) => `${key} ${formatCompactNumber(value)}`).join(' · ');

const ridersByModeText = (savings: SavingsShape): string | null => {
  const byMode = arrayOrEmpty<SavingsModeShape>(savings.byMode);
  const parts = byMode
    .map((row) => {
      if (typeof row.mode !== 'string' || typeof row.ridersServed !== 'number') {
        return null;
      }
      return `${row.mode} ${formatCompactNumber(row.ridersServed)}`;
    })
    .filter((part): part is string => part !== null);
  return parts.length === 0 ? null : parts.join(' · ');
};

const MetricsSection = ({
  finished,
  metrics,
  savings,
  rows,
}: {
  readonly finished: readonly RequestRow[];
  readonly metrics: StatusMetricsShape | null;
  readonly savings: SavingsShape | null;
  /** Every visible row (active + recent): attach savings needs leaders in flight too. */
  readonly rows: readonly RequestRow[];
}): ReactNode => {
  const [selectedWindowId, setSelectedWindowId] = useState<MetricsWindowId>(
    defaultMetricsWindowId,
  );
  const windows = dashboardWindows(metrics?.windows);
  const pickedWindow = pickMetricsWindow(windows, selectedWindowId);
  const window = pickedWindow.window;
  const runs = runMetricsView(metrics?.cargo_run_ms);
  // Queue latency derives from the visible finished rows: honest about its
  // window, and available even before the daemon accumulates histograms.
  const waits = finished
    .map((row) => row.waitMs)
    .filter((value): value is number => typeof value === 'number');
  const waitMetrics = waitMetricsView(metrics?.wait_ms_summary, waits);
  const runCount = window?.count ?? runs.count;
  const runMeanMs = window?.runMeanMs ?? runs.meanMs;
  const runP50Ms = runCount < percentileMinSamples ? null : (window?.runP50Ms ?? runs.p50Ms);
  const runP95Ms = runCount < percentileMinSamples ? null : (window?.runP95Ms ?? runs.p95Ms);
  const waitCount = window?.count ?? waitMetrics.count;
  const waitP50Ms =
    waitCount < percentileMinSamples ? null : (window?.waitP50Ms ?? waitMetrics.p50Ms);
  const waitP95Ms =
    waitCount < percentileMinSamples ? null : (window?.waitP95Ms ?? waitMetrics.p95Ms);
  const legacyOutcomeEntries = frequencyEntries(metrics?.job_outcome);
  const legacyOutcomeTotal = frequencyTotal(metrics?.job_outcome);
  const outcomesTotal = window?.count ?? legacyOutcomeTotal;
  const outcomesText =
    window === null
      ? (legacyOutcomeEntries.length === 0 ? '—' : frequencyText(legacyOutcomeEntries))
      : `done ${formatCompactNumber(window.done)} · failed ${formatCompactNumber(window.failed)} · killed ${formatCompactNumber(window.killed)}`;
  const attachEntries = frequencyEntries(metrics?.attach_mode);
  const attachTotal = frequencyTotal(metrics?.attach_mode);
  const percentileScale = runP95Ms ?? runP50Ms ?? 0;
  // Check and test are different populations: the since-start histogram
  // cannot be split retroactively, so the split comes from the visible
  // finished rows, each line carrying its own honest n.
  const legacyBySubcommand = subcommandMetricsView(metrics?.cargo_run_ms_by_kind, finished);
  const bySubcommandRows = window?.bySubcommand ?? legacyBySubcommand.rows;
  const bySubcommandCaption =
    window !== null
      ? `${metricsWindowLabel(window.id)} window`
      : legacyBySubcommand.source === 'daemon-lifetime'
        ? 'daemon-lifetime'
        : `last ${finished.length} finished`;
  const visibleSavings = attachSavings(rows);
  const totals = asRecord(savings?.totals) as SavingsTotalsShape | null;
  const allTimeComputeMs =
    totals !== null && typeof totals.savedComputeMs === 'number' ? totals.savedComputeMs : null;
  const allTimeExactMs =
    totals !== null && typeof totals.savedComputeExactMs === 'number' ? totals.savedComputeExactMs : null;
  const allTimeEstimatedMs =
    totals !== null && typeof totals.savedComputeEstimatedMs === 'number'
      ? totals.savedComputeEstimatedMs
      : null;
  const allTimeLatencyMs =
    totals !== null && typeof totals.savedLatencyMs === 'number' ? totals.savedLatencyMs : null;
  const allTimeNegativeLatencyCount =
    totals !== null && typeof totals.negativeLatencyRiders === 'number'
      ? totals.negativeLatencyRiders
      : null;
  const hasLedgerSavings =
    allTimeComputeMs !== null &&
    allTimeExactMs !== null &&
    allTimeEstimatedMs !== null &&
    allTimeLatencyMs !== null &&
    allTimeNegativeLatencyCount !== null;
  const fallbackSavedText =
    visibleSavings.savedExactMs > 0
      ? `${formatMs(visibleSavings.savedExactMs)}${
          visibleSavings.savedEstimatedMs > 0
            ? ` +~${formatMs(visibleSavings.savedEstimatedMs)} est`
            : ''
        }`
      : visibleSavings.savedEstimatedMs > 0
        ? `~${formatMs(visibleSavings.savedEstimatedMs)} est`
        : null;
  const computeValue = hasLedgerSavings
    ? formatMs(allTimeComputeMs)
    : (fallbackSavedText ?? '—');
  const computeSplitText = hasLedgerSavings
    ? `${formatMs(allTimeExactMs)} exact + ~${formatMs(allTimeEstimatedMs)} est`
    : null;
  const latencyValue =
    hasLedgerSavings && allTimeLatencyMs !== null ? signedDuration(allTimeLatencyMs) : '—';
  const latencyTitle =
    hasLedgerSavings && allTimeNegativeLatencyCount !== null
      ? `counterfactual estimateMs minus actual time-to-result; negative means the rider waited longer than its own solo estimate (${formatCompactNumber(allTimeNegativeLatencyCount)} rider${allTimeNegativeLatencyCount === 1 ? '' : 's'} are negative)`
      : 'available from newer daemons; negative means the rider waited longer than its own solo estimate';
  const ridersByMode = hasLedgerSavings && savings !== null ? ridersByModeText(savings) : null;
  const percentileText = (count: number, value: number | null): string =>
    count === 0 ? '—' : (count < percentileMinSamples || value === null)
      ? `n<${percentileMinSamples}`
      : formatMs(value);

  return (
    <section>
      <h2>
        Metrics{' '}
        {windows.length === 0 ? (
          <span className="count">(since daemon start)</span>
        ) : (
          <span className="window-toggle" role="toolbar" aria-label="metrics window">
            {metricsWindowIds.map((id, index) => (
              <span key={id}>
                {index === 0 ? null : <span className="window-dot">·</span>}
                <button
                  type="button"
                  className={`window-button${pickedWindow.id === id ? ' active' : ''}`}
                  onClick={() => setSelectedWindowId(id)}
                >
                  {metricsWindowLabel(id)}
                </button>
              </span>
            ))}
          </span>
        )}
      </h2>
      <div className="stats">
        <Stat
          label="runs timed (n)"
          title={
            window === null
              ? 'leader cargo runs with a recorded duration since daemon start; all subcommands blended — see the per-command split below'
              : `leader cargo runs in the selected ${metricsWindowLabel(window.id)} window; all subcommands blended — see the per-command split below`
          }
          value={formatCompactNumber(runCount)}
        />
        <Stat
          barPercent={
            runP50Ms === null || percentileScale <= 0
              ? undefined
              : (runP50Ms / percentileScale) * 100
          }
          label="run p50"
          title="all subcommands blended; per-command timings are split below"
          value={percentileText(runCount, runP50Ms)}
        />
        <Stat
          barPercent={percentileScale <= 0 || runP95Ms === null ? undefined : (runP95Ms / percentileScale) * 100}
          label="run p95"
          title={`hidden until ${percentileMinSamples} runs (have ${runCount})`}
          value={percentileText(runCount, runP95Ms)}
        />
        <Stat label="run mean" value={runMeanMs === null ? '—' : formatMs(runMeanMs)} />
        <Stat
          label="wait p50"
          title={`hidden until ${percentileMinSamples} samples (have ${waitCount})`}
          value={percentileText(waitCount, waitP50Ms)}
        />
        <Stat
          label="wait p95"
          title={`hidden until ${percentileMinSamples} samples (have ${waitCount})`}
          value={percentileText(waitCount, waitP95Ms)}
        />
        <Stat
          label={`outcomes (n=${formatCompactNumber(outcomesTotal)})`}
          title={
            window === null
              ? 'finished requests by outcome since daemon start'
              : `leader runs by terminal outcome in the selected ${metricsWindowLabel(window.id)} window`
          }
          value={outcomesText}
        />
        <Stat
          label={hasLedgerSavings ? 'compute avoided (all time)' : 'attach time saved (visible rows)'}
          title={
            hasLedgerSavings
              ? `sum of per-follower saved compute from the ledger (survives restarts): ${computeSplitText}`
              : "follower runtime avoided in visible rows: leader run time when visible, otherwise follower estimate"
          }
          value={computeValue}
        />
        <Stat
          label="latency saved (all time)"
          title={latencyTitle}
          value={latencyValue}
        />
        {attachTotal > 0 ? (
          <Stat
            label="runs avoided (attach)"
            title="requests served by attaching to another in-flight run (identity, coverage, or batch coalescing) — hauler scheduling, not kache cache hits"
            value={formatCompactNumber(attachTotal)}
          />
        ) : null}
      </div>
      {attachEntries.length === 0 && ridersByMode === null ? null : (
        <div className="stats">
          {attachEntries.length === 0 ? null : (
            <Stat label="attach modes" value={frequencyText(attachEntries)} />
          )}
          {ridersByMode === null ? null : (
            <Stat
              label="riders served by mode (all time)"
              title="followers that reached terminal service outcomes, grouped by attach mode"
              value={ridersByMode}
            />
          )}
          {visibleSavings.batchExtraPackages > 0 ? (
            <Stat
              label="batch extra packages (visible)"
              title="extra -p packages folded into visible batch leaders"
              value={formatCompactNumber(visibleSavings.batchExtraPackages)}
            />
          ) : null}
        </div>
      )}
      <div className="subcommand-split">
        <h3>
          By command <span>({bySubcommandCaption} — separate populations, not the histogram above)</span>
        </h3>
        {bySubcommandRows.length === 0 ? (
          <p className="empty">No command timings in this window.</p>
        ) : (
          bySubcommandRows.map((timing) => (
            <div className="compact-row" key={`${timing.subcommand}\0${timing.profile ?? ''}`}>
              <span className="cmd">{subcommandDisplayLabel(timing)}</span>
              <span className="row-value">
                n={timing.count} · p50{' '}
                {timing.count < percentileMinSamples
                  ? `n<${percentileMinSamples}`
                  : (timing.p50Ms === null ? '—' : formatMs(timing.p50Ms))}{' '}
                · max {timing.maxMs === null ? '—' : formatMs(timing.maxMs)}
              </span>
            </div>
          ))
        )}
      </div>
    </section>
  );
};

const KacheSection = ({ value }: { readonly value: unknown }): ReactNode => {
  const kache = asRecord(value) as KacheShape | null;
  if (kache?.available !== true) {
    return null;
  }
  const roots = arrayOrEmpty<KacheRootRow>(kache.recentHeartbeatRoots).filter(
    (row) => typeof row.root === 'string' && typeof row.count === 'number',
  );
  const topCrates = arrayOrEmpty<KacheTopCrateRow>(kache.topCrates).filter(
    (row) =>
      typeof row.crate === 'string' &&
      typeof row.profile === 'string' &&
      typeof row.ms === 'number' &&
      row.ms > 0,
  );
  return (
    <section className="kache-section">
      <h2>Kache <span className="count">(machine-wide)</span></h2>
      <div className="stats">
        <Stat label="entries" value={countValue(kache.entryCount)} />
        <Stat label="crates" value={countValue(kache.distinctCrates)} />
        <Stat
          label="index size"
          value={
            typeof kache.indexSizeBytes === 'number' ? formatBytes(kache.indexSizeBytes) : '—'
          }
        />
        <Stat
          label="events fresh"
          value={
            typeof kache.eventsFreshMs === 'number'
              ? `${formatMs(kache.eventsFreshMs)} ago`
              : '—'
          }
        />
      </div>
      <KacheColumns roots={roots} topCrates={topCrates} />
    </section>
  );
};

const KacheColumns = ({
  roots,
  topCrates,
}: {
  readonly roots: readonly KacheRootRow[];
  readonly topCrates: readonly KacheTopCrateRow[];
}): ReactNode => {
  const columns = kacheColumns({ crates: topCrates.length, roots: roots.length });
  if (columns.length === 0) {
    return null;
  }
  return (
    <div className={`kache-columns${columns.length === 1 ? ' single' : ''}`}>
      {columns.map((column) => {
        switch (column) {
          case 'roots':
            return (
              <div key="roots">
                <h3>Compiling roots <span>(last 5m)</span></h3>
                <div>
                  {roots.map((row, index) => {
                    const root = typeof row.root === 'string' ? row.root : '';
                    return (
                      <div className="compact-row" key={`${root}-${index}`}>
                        <span className="path" title={root}>{shortenPath(root)}</span>
                        <span className="row-value">{countValue(row.count)}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          case 'crates':
            return (
              <div key="crates">
                <h3>Slowest crates <span>(per profile)</span></h3>
                {kacheProfileGroups(topCrates).map((group) => (
                  <div className="crate-group" key={group.profile}>
                    <div className="crate-group-head">
                      <span className="profile">{group.profile}</span>
                    </div>
                    <div>
                      {group.rows.map((row) => (
                        <div className="crate-row" key={`${group.profile}-${row.crate}`}>
                          <div className="crate-label">
                            <span className="crate-name" title={row.crate}>{row.crate}</span>
                            <span className="row-value">{formatMs(row.ms)}</span>
                          </div>
                          <div className="crate-meter" aria-hidden="true">
                            <div
                              className="crate-meter-fill"
                              style={{
                                width: `${group.maxMs > 0 ? (row.ms / group.maxMs) * 100 : 0}%`,
                              }}
                            />
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            );
          default: {
            const exhaustive: never = column;
            return exhaustive;
          }
        }
      })}
    </div>
  );
};

const DashboardContent = ({ structured }: { readonly structured: StructuredContent | null }) => {
  const nowMs = Date.now();
  const [drawer, setDrawer] = useState<DrawerState>({ _tag: 'Closed' });
  const drawerSeq = useRef(0);
  const active = arrayOrEmpty<RequestRow>(structured?.active);
  const recent = arrayOrEmpty<RequestRow>(structured?.recent);
  const lanes = arrayOrEmpty<LaneRow>(structured?.lanes);
  const running = active.filter((row) => row.status === 'running');
  const queued = active.filter((row) => row.status === 'queued' || row.status === 'requested');
  const attached = active.filter((row) => typeof row.attachedTo === 'string');
  const maxConcurrent = typeof structured?.maxConcurrent === 'number' ? structured.maxConcurrent : 0;
  const queueRows = queued.concat(attached.filter((row) => row.status !== 'running'));
  const activeLanes = lanes.filter(laneIsActive);
  const finished = recent
    .filter((row) => typeof row.status === 'string' && terminalStatuses.has(row.status))
    .slice(0, 20);
  const metrics = (structured?.metrics ?? null) as StatusMetricsShape | null;
  const savings = (structured?.savings ?? null) as SavingsShape | null;
  const system = (structured?.system ?? null) as SystemLoadShape | null;
  const permitHolders = running.filter((row) => row.attachedTo == null).length;
  const riders = running.length - permitHolders;
  const laneCount =
    activeLanes.length === lanes.length
      ? String(lanes.length)
      : `${activeLanes.length} active · ${lanes.length} seen`;
  const daemonState = structured?.daemon;
  const daemonUp = daemonState === 'running';

  const closeDrawer = (): void => {
    drawerSeq.current += 1;
    setDrawer({ _tag: 'Closed' });
  };
  const openTicket = (row: RequestRow): void => {
    const base = ticketDetailFrom(row);
    if (base === null) {
      return;
    }
    const seq = ++drawerSeq.current;
    setDrawer({ _tag: 'Loading', detail: base });
    // While the run is live the daemon overlays an in-progress output tail
    // onto the result record, so keep re-fetching until the ticket settles
    // (seq guard cancels the loop when the drawer closes or switches rows).
    const liveRefreshMs = 3_000;
    const load = (): void => {
      resolveTicketDetail(row, fetchTicketRecord).then(
        (detail) => {
          if (drawerSeq.current !== seq) {
            return;
          }
          const next = detail ?? base;
          setDrawer({ _tag: 'Loaded', detail: next });
          if (!terminalStatuses.has(next.status)) {
            setTimeout(() => {
              if (drawerSeq.current === seq) {
                load();
              }
            }, liveRefreshMs);
          }
        },
        (error: unknown) => {
          if (drawerSeq.current === seq) {
            setDrawer({
              _tag: 'Failed',
              detail: base,
              message: error instanceof Error ? error.message : String(error),
            });
          }
        },
      );
    };
    load();
  };
  const selectRow = (row: RequestRow): (() => void) | undefined =>
    typeof row.ticket === 'string' ? () => openTicket(row) : undefined;

  const renderSection = (section: DashboardSection): ReactNode => {
    switch (section) {
      case 'contention':
        return (
          <section key="contention">
            <h2>Contention</h2>
            {daemonUp ? (
              <div className="stats">
                <LoadStat system={system} />
                <MemoryStat system={system} />
                <DiskIoStat system={system} />
                <AdmissionMeter
                  heavyNote={heavyAdmissionNote(system ?? {})}
                  permitHolders={permitHolders}
                  riders={riders}
                  maxConcurrent={maxConcurrent}
                />
              </div>
            ) : daemonState === 'unresponsive' ? (
              <p className="down-cue">
                Daemon is up but did not answer in time — the machine is saturated. Rows below
                come from the ledger and in-flight runs are still live; this refreshes on the next poll.
              </p>
            ) : (
              <p className="down-cue">
                Daemon is not running — it starts on demand with any cargo exec, or run{' '}
                <code>hauler daemon start</code>.
              </p>
            )}
          </section>
        );
      case 'inFlight':
        return (
          <section key="inFlight">
            <h2>In flight <span className="count">({running.length})</span></h2>
            <Table
              empty="Nothing running."
              headers={['ticket', 'command', 'workspace', 'who', 'elapsed']}
              numericColumns={[4]}
              rows={running.map((row) => ({
                cells: [
                  ...requestCells(row),
                  elapsedCell(
                    row.startedAtMs ?? row.createdAtMs,
                    row.estimateMs,
                    row.waitMs,
                    row.quietMs,
                    nowMs,
                    row.stall,
                    typeof row.attachedTo === 'string' ? row.attachedTo : row.ticket,
                  ),
                ],
                onSelect: selectRow(row),
              }))}
            />
          </section>
        );
      case 'queue':
        return (
          <section key="queue">
            <h2>Queue <span className="count">({queueRows.length})</span></h2>
            <Table
              empty="Empty."
              headers={['ticket', 'command', 'workspace', 'who', 'waiting', 'attached']}
              numericColumns={[4]}
              rows={queueRows.map((row) => ({
                cells: [
                  ...requestCells(row),
                  waitingCell(row.createdAtMs, row.estimateMs, row.delayed, row.admissionHold, nowMs),
                  typeof row.attachedTo === 'string' ? <AttachChip row={row} /> : '—',
                ],
                onSelect: selectRow(row),
              }))}
            />
          </section>
        );
      case 'metrics':
        return (
          <MetricsSection
            finished={finished}
            key="metrics"
            metrics={metrics}
            savings={savings}
            rows={active.concat(recent)}
          />
        );
      case 'kache':
        return <KacheSection key="kache" value={structured?.kache} />;
      case 'lanes':
        return (
          <section key="lanes">
            <h2>Lanes <span className="count">({laneCount})</span></h2>
            <Table
              empty="No active lanes."
              headers={['workspace', 'running', 'queued']}
              numericColumns={[2]}
              rows={activeLanes.map((lane) => ({
                cells: [
                  workspace(lane.workspaceRoot),
                  ticket(typeof lane.runningTicket === 'string' ? lane.runningTicket : null),
                  typeof lane.queued === 'number' ? String(lane.queued) : '—',
                ],
              }))}
            />
          </section>
        );
      case 'history':
        return (
          <section key="history">
            <h2>History <span className="count">({finished.length})</span></h2>
            <Table
              empty="No finished work yet."
              headers={['ticket', 'status', 'who', 'age', 'wait', 'run', 'command']}
              numericColumns={[3, 4, 5]}
              rows={finished.map((row) => ({
                cells: [
                  ticket(row.ticket),
                  <><StatusPill status={row.status} /><DiagBadges row={row} /></>,
                  who(row),
                  typeof row.createdAtMs === 'number' ? relativeTime(row.createdAtMs, nowMs) : '—',
                  duration(row.waitMs),
                  duration(row.runMs),
                  <><Command row={row} /><AttachChip row={row} /></>,
                ],
                onSelect: selectRow(row),
              }))}
            />
          </section>
        );
      default: {
        const exhaustive: never = section;
        return exhaustive;
      }
    }
  };

  return (
    <div className="grid">
      {sectionOrder.map(renderSection)}
      <TicketDrawer onClose={closeDrawer} state={drawer} />
    </div>
  );
};

type StatusPollResult = AsyncResult.AsyncResult<StatusPoll<StructuredContent | null>, unknown>;

const pollSnapshot = (poll: StatusPoll<StructuredContent | null>): StatusSnapshot | null =>
  poll.updatedAtMs === null ? null : { timestamp: poll.updatedAtMs, value: poll.value };

const snapshotFrom = (result: StatusPollResult): StatusSnapshot | null => {
  switch (result._tag) {
    case 'Initial':
      return null;
    case 'Success':
      return pollSnapshot(result.value);
    case 'Failure': {
      const previous = Option.getOrUndefined(result.previousSuccess);
      return previous === undefined ? null : pollSnapshot(previous.value);
    }
    default: {
      const exhaustive: never = result;
      return exhaustive;
    }
  }
};

const failureMessage = (cause: Cause.Cause<unknown>): string => {
  const error = Cause.squash(cause);
  return error instanceof Error ? error.message : String(error);
};

/**
 * The error to surface above the grid: a failed poll travels inside the
 * Success value (the stream itself never fails, so polling continues), while
 * the Failure branch only catches defects escaping the stream machinery.
 */
const pollErrorFrom = (result: StatusPollResult): string | null => {
  switch (result._tag) {
    case 'Initial':
      return null;
    case 'Success':
      return result.value.error;
    case 'Failure':
      return failureMessage(result.cause);
    default: {
      const exhaustive: never = result;
      return exhaustive;
    }
  }
};

const DashboardHeader = ({ children }: { readonly children: ReactNode }) => (
  <header>
    <h1>cargo-hauler</h1>
    <div id="status">{children}</div>
  </header>
);

const Dashboard = ({ pushed }: { readonly pushed: PushedStatus | null }) => {
  const result = useAtomValue(statusAtom);
  const refresh = useAtomRefresh(statusAtom);
  const polled = snapshotFrom(result);
  const pollError = pollErrorFrom(result);
  const latest =
    pushed !== null && (polled === null || pushed.receivedAt >= polled.timestamp)
      ? pushed.value
      : (polled?.value ?? null);
  const summary =
    latest === null && result._tag === 'Initial'
      ? 'Loading…'
      : typeof latest?.summary === 'string'
        ? summaryFirstLine(latest.summary)
        : 'Updated.';

  return (
    <main>
      <DashboardHeader>
        {summary}
        {result.waiting ? <span className="refreshing" title="Refreshing status">●</span> : null}
      </DashboardHeader>
      {pollError !== null ? (
        <div className="error-line">
          Error: {pollError}{' '}
          <button type="button" onClick={refresh}>Retry</button>
        </div>
      ) : null}
      <DashboardContent structured={latest} />
    </main>
  );
};

const DashboardApp = () => {
  const setPushed = useAtomSet(pushedStatusAtom);
  const pushed = useAtomValue(pushedStatusAtom);
  const [initialization, setInitialization] = useState<Initialization>({
    _tag: 'Initializing',
  });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    const onMessage = (event: MessageEvent): void => {
      const message = event.data as JsonRpcMessage | null;
      if (message === null || message.jsonrpc !== '2.0') {
        return;
      }
      if (typeof message.id === 'number') {
        const waiter = pending.get(message.id);
        if (waiter !== undefined) {
          pending.delete(message.id);
          if (message.error) {
            const reason =
              typeof message.error.message === 'string' ? message.error.message : 'tool call failed';
            waiter.reject(new Error(reason));
          } else {
            waiter.resolve(message.result ?? {});
          }
          return;
        }
      }
      if (message.method === 'ui/notifications/tool-result') {
        const value = structuredFrom(message.params);
        if (value !== null) {
          setPushed({ receivedAt: Date.now(), value });
        }
      }
    };

    window.addEventListener('message', onMessage);
    setInitialization({ _tag: 'Initializing' });
    void rpcRequest('ui/initialize', {
      appCapabilities: { availableDisplayModes: ['inline'] },
      appInfo: { name: 'cargo-hauler', version: dashboardVersion },
      protocolVersion: '2026-01-26',
    }).then(
      () => {
        if (!active) {
          return;
        }
        postMessage({ jsonrpc: '2.0', method: 'ui/notifications/initialized', params: {} });
        setInitialization({ _tag: 'Ready' });
      },
      (error: unknown) => {
        if (active) {
          setInitialization({
            _tag: 'Failed',
            error: error instanceof Error ? error : new Error(String(error)),
          });
        }
      },
    );

    return () => {
      active = false;
      window.removeEventListener('message', onMessage);
      for (const waiter of pending.values()) {
        waiter.reject(new Error('dashboard unmounted'));
      }
      pending.clear();
    };
  }, [attempt, setPushed]);

  switch (initialization._tag) {
    case 'Initializing':
      return (
        <main>
          <DashboardHeader>Connecting…</DashboardHeader>
        </main>
      );
    case 'Ready':
      return <Dashboard pushed={pushed} />;
    case 'Failed':
      return (
        <main>
          <DashboardHeader>Error: {initialization.error.message}</DashboardHeader>
          <div className="error-line">
            Could not initialize the MCP App.{' '}
            <button type="button" onClick={() => setAttempt((value) => value + 1)}>Retry</button>
          </div>
        </main>
      );
    default: {
      const exhaustive: never = initialization;
      return exhaustive;
    }
  }
};

const root = document.getElementById('root');
if (root === null) {
  throw new Error('Dashboard root was not found');
}

createRoot(root).render(
  <RegistryProvider>
    <DashboardApp />
  </RegistryProvider>,
);
