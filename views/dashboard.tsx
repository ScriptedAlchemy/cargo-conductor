import { RegistryProvider, useAtomRefresh, useAtomSet, useAtomValue } from '@effect/atom-react';
import { Cause, Effect, Option, Schedule, Stream } from 'effect';
import { AsyncResult, Atom } from 'effect/unstable/reactivity';
import { useEffect, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';

import {
  argvText,
  argvTitle,
  dashboardVersion,
  DEMUX_FLAG,
  formatMs,
  ranAsFor,
  relativeTime,
  shortenPath,
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

interface StructuredContent {
  readonly summary?: unknown;
  readonly daemon?: unknown;
  readonly pid?: unknown;
  readonly maxConcurrent?: unknown;
  readonly lanes?: unknown;
  readonly active?: unknown;
  readonly recent?: unknown;
  readonly operation?: unknown;
  readonly structuredContent?: unknown;
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
const terminalStatuses = new Set(['done', 'failed', 'killed']);
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

const fetchStatus = Effect.tryPromise({
  try: async () => {
    const response = await rpcRequest('tools/call', {
      arguments: { limit: 40 },
      name: 'conductor_status',
    });
    return structuredFrom(response);
  },
  catch: (error) => (error instanceof Error ? error : new Error(String(error))),
});

export const statusAtom = Atom.make(
  Stream.fromEffectSchedule(fetchStatus, Schedule.spaced('5 seconds')),
);

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

const Table = ({
  headers,
  rows,
}: {
  readonly headers: readonly string[];
  readonly rows: readonly (readonly ReactNode[])[];
}): ReactNode => {
  if (rows.length === 0) {
    return <p className="empty">None.</p>;
  }
  return (
    <table>
      <thead>
        <tr>
          {headers.map((header) => <th key={header}>{header}</th>)}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, rowIndex) => (
          <tr key={rowIndex}>
            {row.map((cell, cellIndex) => <td key={cellIndex}>{cell}</td>)}
          </tr>
        ))}
      </tbody>
    </table>
  );
};

const Stat = ({ label, value }: { readonly label: string; readonly value: string }): ReactNode => (
  <div className="stat">
    <b>{value}</b>
    <span>{label}</span>
  </div>
);

const AdmissionMeter = ({
  maxConcurrent,
  runningCount,
}: {
  readonly maxConcurrent: number;
  readonly runningCount: number;
}): ReactNode => {
  const percent =
    maxConcurrent > 0 ? Math.min(100, Math.round((runningCount / maxConcurrent) * 100)) : 0;
  return (
    <div className="stat meterstat">
      <b>{runningCount}/{maxConcurrent > 0 ? maxConcurrent : '—'}</b>
      <span>admission</span>
      <div
        className="meter"
        title={`${runningCount} of ${maxConcurrent} admission permits in use`}
      >
        <div className="meter-fill" style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
};

const StatusPill = ({ status }: { readonly status: unknown }): ReactNode => {
  const value = typeof status === 'string' && terminalStatuses.has(status) ? status : 'unknown';
  return <span className={`pill ${value}`}>{value}</span>;
};

const DashboardContent = ({ structured }: { readonly structured: StructuredContent | null }) => {
  const nowMs = Date.now();
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
  const laneCount =
    activeLanes.length === lanes.length
      ? String(lanes.length)
      : `${activeLanes.length} active · ${lanes.length} seen`;

  return (
    <div className="grid">
      <section>
        <h2>Contention</h2>
        <div className="stats">
          <Stat label="daemon" value={structured?.daemon === 'running' ? 'up' : 'down'} />
          <Stat label="pid" value={structured?.pid == null ? '—' : String(structured.pid)} />
          <Stat label="queued" value={String(queued.length)} />
          <Stat label="attached" value={String(attached.length)} />
          <AdmissionMeter runningCount={running.length} maxConcurrent={maxConcurrent} />
        </div>
      </section>
      <section>
        <h2>In flight <span className="count">({running.length})</span></h2>
        <Table
          headers={['ticket', 'command', 'workspace', 'who', 'elapsed']}
          rows={running.map((row) => [
            ...requestCells(row),
            progress(row.startedAtMs ?? row.createdAtMs, row.estimateMs, nowMs),
          ])}
        />
      </section>
      <section>
        <h2>Queue <span className="count">({queueRows.length})</span></h2>
        <Table
          headers={['ticket', 'command', 'workspace', 'who', 'waiting', 'attached']}
          rows={queueRows.map((row) => [
            ...requestCells(row),
            progress(row.createdAtMs, row.estimateMs, nowMs),
            typeof row.attachedTo === 'string' ? <AttachChip row={row} /> : '—',
          ])}
        />
      </section>
      <section>
        <h2>Lanes <span className="count">({laneCount})</span></h2>
        <Table
          headers={['workspace', 'running', 'queued']}
          rows={activeLanes.map((lane) => [
            workspace(lane.workspaceRoot),
            ticket(typeof lane.runningTicket === 'string' ? lane.runningTicket : null),
            typeof lane.queued === 'number' ? String(lane.queued) : '—',
          ])}
        />
      </section>
      <section>
        <h2>History <span className="count">({finished.length})</span></h2>
        <Table
          headers={['ticket', 'status', 'who', 'age', 'wait', 'run', 'command']}
          rows={finished.map((row) => [
            ticket(row.ticket),
            <StatusPill status={row.status} />,
            who(row),
            typeof row.createdAtMs === 'number' ? relativeTime(row.createdAtMs, nowMs) : '—',
            duration(row.waitMs),
            duration(row.runMs),
            <><Command row={row} /><AttachChip row={row} /></>,
          ])}
        />
      </section>
    </div>
  );
};

const snapshotFrom = (
  result: AsyncResult.AsyncResult<StructuredContent | null, unknown>,
): StatusSnapshot | null => {
  switch (result._tag) {
    case 'Initial':
      return null;
    case 'Success':
      return { timestamp: result.timestamp, value: result.value };
    case 'Failure': {
      const previous = Option.getOrUndefined(result.previousSuccess);
      return previous === undefined
        ? null
        : { timestamp: previous.timestamp, value: previous.value };
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

const Dashboard = ({ pushed }: { readonly pushed: PushedStatus | null }) => {
  const result = useAtomValue(statusAtom);
  const refresh = useAtomRefresh(statusAtom);
  const polled = snapshotFrom(result);
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
      {result._tag === 'Failure' ? (
        <div className="error-line">
          Error: {failureMessage(result.cause)}{' '}
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
