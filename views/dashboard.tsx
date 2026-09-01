import { RegistryProvider, useAtomRefresh, useAtomSet, useAtomValue } from '@effect/atom-react';
import { Cause, Data, Effect, Option } from 'effect';
import { AsyncResult, Atom } from 'effect/unstable/reactivity';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';

import {
  argvText,
  argvTitle,
  dashboardVersion,
  DEMUX_FLAG,
  formatBytes,
  formatCompactNumber,
  formatMs,
  frequencyEntries,
  frequencyTotal,
  percentileMinSamples,
  pollStatus,
  ranAsFor,
  relativeTime,
  resolveTicketDetail,
  runMetricsView,
  sectionOrder,
  shortenPath,
  terminalStatuses,
  ticketDetailFrom,
  type RunHistogramShape,
  type StatusPoll,
  type TicketDetail,
} from './dashboard-lib.js';

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
  readonly system?: unknown;
  readonly kache?: unknown;
}

interface StatusMetricsShape {
  readonly cargo_run_ms?: RunHistogramShape;
  readonly attach_mode?: Readonly<Record<string, unknown>>;
  readonly job_outcome?: Readonly<Record<string, unknown>>;
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
  readonly workspaceRoot?: unknown;
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
      name: 'conductor_status',
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
 * while `conductor_result` reads the full ledger record, tail included.
 */
const fetchTicketRecord = async (ticketId: string): Promise<unknown> => {
  const response = await rpcRequest('tools/call', {
    arguments: { ticket: ticketId },
    name: 'conductor_result',
  });
  return asRecord(response.structuredContent)?.request ?? null;
};

const arrayOrEmpty = <T,>(value: unknown): readonly T[] => (Array.isArray(value) ? value : []);

const duration = (value: unknown): string => (typeof value === 'number' ? formatMs(value) : '—');

const ticket = (value: unknown): ReactNode =>
  value == null ? '—' : <span className="ticket">{String(value)}</span>;

const workspace = (value: unknown): ReactNode =>
  typeof value !== 'string' || value.length === 0 ? (
    '—'
  ) : (
    <span className="path" title={value}>
      {shortenPath(value)}
    </span>
  );

const who = (row: RequestRow): ReactNode => {
  const host = typeof row.host === 'string' ? row.host : null;
  const session = typeof row.session === 'string' ? row.session : null;
  if (host === null && session === null) {
    return '—';
  }
  const label = session === null || session === host ? (host ?? '') : `${host ?? '?'} · ${session}`;
  return (
    <span className="who" title={label}>
      {label}
    </span>
  );
};

const progress = (sinceMs: unknown, estimateMs: unknown, nowMs: number): ReactNode => {
  if (typeof sinceMs !== 'number') {
    return '—';
  }
  return (
    <>
      <span className="dur">{formatMs(Math.max(0, nowMs - sinceMs))}</span>
      {typeof estimateMs === 'number' && estimateMs > 0 ? (
        <span className="est"> / ~{formatMs(estimateMs)}</span>
      ) : null}
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

const Command = ({ row }: { readonly row: RequestRow }): ReactNode => {
  const ranAs = ranAsFor(row.argv, row.execArgv);
  const execArgv = Array.isArray(row.execArgv)
    ? row.execArgv.filter((part): part is string => typeof part === 'string' && part !== DEMUX_FLAG)
    : null;
  return (
    <>
      <span className="cmd" title={argvTitle(row.argv)}>
        {argvText(row.argv)}
      </span>
      {ranAs === null ? null : (
        <div className="ranas">
          ran as:{' '}
          <span className="cmd" title={execArgv === null ? ranAs.command : argvTitle(execArgv)}>
            {ranAs.command}
          </span>
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
  <Command row={row} />,
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
  value,
}: {
  readonly barPercent?: number;
  readonly label: string;
  readonly value: string;
}): ReactNode => (
  <div className="stat">
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
  maxConcurrent,
  permitHolders,
  riders,
}: {
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
      </b>
      <span>admission</span>
      <div
        className="meter"
        title={`${permitHolders} of ${maxConcurrent} admission permits in use; ${riders} attached request${riders === 1 ? '' : 's'} riding leaders`}
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
    case 'Loaded':
      return state.detail.outputTail === null ? (
        <p className="empty">
          {terminalStatuses.has(state.detail.status)
            ? 'No output was captured for this ticket.'
            : 'No output yet — the tail is captured when the run finishes.'}
        </p>
      ) : (
        <pre className="output">{state.detail.outputTail}</pre>
      );
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

const MetricsSection = ({
  finished,
  metrics,
}: {
  readonly finished: readonly RequestRow[];
  readonly metrics: StatusMetricsShape | null;
}): ReactNode => {
  const runs = runMetricsView(metrics?.cargo_run_ms);
  // Queue latency derives from the visible finished rows: honest about its
  // window, and available even before the daemon accumulates histograms.
  const waits = finished
    .map((row) => row.waitMs)
    .filter((value): value is number => typeof value === 'number')
    .sort((left, right) => left - right);
  const waitP50 = waits.length === 0 ? null : waits[Math.floor((waits.length - 1) * 0.5)];
  const waitMax = waits.length === 0 ? null : waits[waits.length - 1];
  const outcomes = frequencyEntries(metrics?.job_outcome);
  const attachEntries = frequencyEntries(metrics?.attach_mode);
  const attachTotal = frequencyTotal(metrics?.attach_mode);
  const percentileScale = runs.p95Ms ?? runs.p50Ms ?? 0;

  return (
    <section>
      <h2>Metrics <span className="count">(since daemon start)</span></h2>
      <div className="stats">
        <Stat label="runs tracked (n)" value={formatCompactNumber(runs.count)} />
        <Stat
          barPercent={
            runs.p50Ms === null || percentileScale <= 0
              ? undefined
              : (runs.p50Ms / percentileScale) * 100
          }
          label="run p50"
          value={runs.p50Ms === null ? '—' : `≤${formatMs(runs.p50Ms)}`}
        />
        {/* p95 on a tiny sample is just "slowest run so far": gated in runMetricsView. */}
        {runs.p95Ms === null ? (
          runs.count > 0 ? (
            <div className="stat" title={`p95 hidden until ${percentileMinSamples} runs (have ${runs.count})`}>
              <b className="gated">n&lt;{percentileMinSamples}</b>
              <span>run p95</span>
            </div>
          ) : null
        ) : (
          <Stat
            barPercent={percentileScale <= 0 ? undefined : (runs.p95Ms / percentileScale) * 100}
            label="run p95"
            value={`≤${formatMs(runs.p95Ms)}`}
          />
        )}
        <Stat label="run mean" value={runs.meanMs === null ? '—' : formatMs(runs.meanMs)} />
        <Stat
          label={`wait p50 (last ${waits.length})`}
          value={waitP50 === null ? '—' : formatMs(waitP50)}
        />
        <Stat label="wait max" value={waitMax === null ? '—' : formatMs(waitMax)} />
        {attachTotal > 0 ? (
          <Stat label="runs avoided" value={formatCompactNumber(attachTotal)} />
        ) : null}
      </div>
      {outcomes.length === 0 && attachEntries.length === 0 ? null : (
        <div className="stats metricsdetail">
          {outcomes.length === 0 ? null : (
            <Stat label="outcomes" value={frequencyText(outcomes)} />
          )}
          {attachEntries.length === 0 ? null : (
            <Stat label="attach modes (runs avoided)" value={frequencyText(attachEntries)} />
          )}
        </div>
      )}
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
  const maximumMs = topCrates.reduce(
    (maximum, row) => Math.max(maximum, typeof row.ms === 'number' ? row.ms : 0),
    0,
  );
  const countValue = (value: unknown): string =>
    typeof value === 'number' ? formatCompactNumber(value) : '—';

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
      <div className="kache-columns">
        <div>
          <h3>Compiling roots <span>(last 5m)</span></h3>
          {roots.length === 0 ? (
            <p className="empty">No recent heartbeats.</p>
          ) : (
            <div className="root-list">
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
          )}
        </div>
        <div>
          <h3>Slowest crates</h3>
          {topCrates.length === 0 ? (
            <p className="empty">No compile timings.</p>
          ) : (
            <div className="crate-list">
              {topCrates.map((row, index) => {
                const crate = typeof row.crate === 'string' ? row.crate : '';
                const profile = typeof row.profile === 'string' ? row.profile : '';
                const ms = typeof row.ms === 'number' ? row.ms : 0;
                return (
                  <div className="crate-row" key={`${crate}-${profile}-${index}`}>
                    <div className="crate-label">
                      <span className="crate-name" title={crate}>{crate}</span>
                      <span className="profile">{profile}</span>
                      <span className="row-value">{formatMs(ms)}</span>
                    </div>
                    <div className="crate-meter" aria-hidden="true">
                      <div
                        className="crate-meter-fill"
                        style={{ width: `${maximumMs > 0 ? (ms / maximumMs) * 100 : 0}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </section>
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
  const activeLanes = lanes.filter(
    (lane) =>
      (typeof lane.queued === 'number' && lane.queued > 0) ||
      typeof lane.runningTicket === 'string',
  );
  const finished = recent
    .filter((row) => typeof row.status === 'string' && terminalStatuses.has(row.status))
    .slice(0, 20);
  const metrics = (structured?.metrics ?? null) as StatusMetricsShape | null;
  const system = (structured?.system ?? null) as SystemLoadShape | null;
  const permitHolders = running.filter((row) => row.attachedTo == null).length;
  const riders = running.length - permitHolders;
  const laneCount =
    activeLanes.length === lanes.length
      ? String(lanes.length)
      : `${activeLanes.length} active · ${lanes.length} seen`;
  const daemonUp = structured?.daemon === 'running';

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
    resolveTicketDetail(row, fetchTicketRecord).then(
      (detail) => {
        if (drawerSeq.current === seq) {
          setDrawer({ _tag: 'Loaded', detail: detail ?? base });
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
  const selectRow = (row: RequestRow): (() => void) | undefined =>
    typeof row.ticket === 'string' ? () => openTicket(row) : undefined;

  const renderSection = (section: ReturnType<typeof sectionOrder>[number]): ReactNode => {
    switch (section) {
      case 'contention':
        return (
          <section key="contention">
            <h2>Contention</h2>
            {daemonUp ? (
              <div className="stats">
                <LoadStat system={system} />
                <AdmissionMeter
                  permitHolders={permitHolders}
                  riders={riders}
                  maxConcurrent={maxConcurrent}
                />
              </div>
            ) : (
              <p className="down-cue">
                Daemon is not running — it starts on demand with any cargo exec, or run{' '}
                <code>conductor daemon start</code>.
              </p>
            )}
          </section>
        );
      case 'inFlight':
        return (
          <section key="inFlight">
            <h2>In flight <span className="count">({running.length})</span></h2>
            <Table
              headers={['ticket', 'command', 'workspace', 'who', 'elapsed']}
              numericColumns={[4]}
              rows={running.map((row) => ({
                cells: [
                  ...requestCells(row),
                  progress(row.startedAtMs ?? row.createdAtMs, row.estimateMs, nowMs),
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
              headers={['ticket', 'command', 'workspace', 'who', 'waiting', 'attached']}
              numericColumns={[4]}
              rows={queueRows.map((row) => ({
                cells: [
                  ...requestCells(row),
                  progress(row.createdAtMs, row.estimateMs, nowMs),
                  typeof row.attachedTo === 'string' ? <AttachChip row={row} /> : '—',
                ],
                onSelect: selectRow(row),
              }))}
            />
          </section>
        );
      case 'metrics':
        return <MetricsSection finished={finished} key="metrics" metrics={metrics} />;
      case 'kache':
        return <KacheSection key="kache" value={structured?.kache} />;
      case 'lanes':
        return (
          <section key="lanes">
            <h2>Lanes <span className="count">({laneCount})</span></h2>
            <Table
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
                  <StatusPill status={row.status} />,
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
      {sectionOrder({
        lanes: activeLanes.length,
        queued: queueRows.length,
        running: running.length,
      }).map(renderSection)}
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
        ? latest.summary
        : 'Updated.';

  return (
    <main>
      <header>
        <h1>cargo-conductor</h1>
        <div id="status">
          {summary}
          {result.waiting ? <span className="refreshing" title="Refreshing status">●</span> : null}
        </div>
      </header>
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
      appInfo: { name: 'cargo-conductor', version: dashboardVersion },
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
          <header>
            <h1>cargo-conductor</h1>
            <div id="status">Connecting…</div>
          </header>
        </main>
      );
    case 'Ready':
      return <Dashboard pushed={pushed} />;
    case 'Failed':
      return (
        <main>
          <header>
            <h1>cargo-conductor</h1>
            <div id="status">Error: {initialization.error.message}</div>
          </header>
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
