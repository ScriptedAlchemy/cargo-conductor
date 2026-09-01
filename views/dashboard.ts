import {
  argvText,
  argvTitle,
  escapeHtml,
  formatMs,
  ranAsFor,
  relativeTime,
  shortenPath,
  startPolling,
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

const statusEl = document.querySelector<HTMLDivElement>('#status')!;
const contentionEl = document.querySelector<HTMLDivElement>('#contention')!;
const lanesEl = document.querySelector<HTMLDivElement>('#lanes')!;
const inflightEl = document.querySelector<HTMLDivElement>('#inflight')!;
const queueEl = document.querySelector<HTMLDivElement>('#queue')!;
const historyEl = document.querySelector<HTMLDivElement>('#history')!;
const pending = new Map<number, PendingRequest>();
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

const arrayOrEmpty = <T>(value: unknown): readonly T[] => (Array.isArray(value) ? value : []);

const terminalStatuses = new Set(['done', 'failed', 'killed']);

const span = (className: string, value: string, title?: string): string =>
  `<span class="${className}"${title === undefined ? '' : ` title="${escapeHtml(title)}"`}>${escapeHtml(value)}</span>`;

const pill = (status: unknown): string => {
  const value = typeof status === 'string' && terminalStatuses.has(status) ? status : 'unknown';
  return span(`pill ${value}`, value);
};

const table = (headers: readonly string[], rows: readonly (readonly string[])[]): string => {
  if (rows.length === 0) {
    return '<p class="empty">None.</p>';
  }
  return `<table><thead><tr>${headers.map((header) => `<th>${header}</th>`).join('')}</tr></thead><tbody>${rows
    .map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join('')}</tr>`)
    .join('')}</tbody></table>`;
};

const stat = (label: string, value: string): string =>
  `<div class="stat"><b>${escapeHtml(value)}</b><span>${escapeHtml(label)}</span></div>`;

const admissionMeter = (runningCount: number, maxConcurrent: number): string => {
  const percent =
    maxConcurrent > 0 ? Math.min(100, Math.round((runningCount / maxConcurrent) * 100)) : 0;
  return (
    `<div class="stat meterstat"><b>${runningCount}/${maxConcurrent > 0 ? maxConcurrent : '—'}</b>` +
    `<span>admission</span>` +
    `<div class="meter" title="${runningCount} of ${maxConcurrent} admission permits in use">` +
    `<div class="meter-fill" style="width: ${percent}%"></div></div></div>`
  );
};

const setCount = (id: string, count: number | string): void => {
  const element = document.querySelector<HTMLSpanElement>(`#${id}`);
  if (element !== null) {
    element.textContent = `(${count})`;
  }
};

const pathCell = (value: unknown): string => {
  if (typeof value !== 'string' || value.length === 0) {
    return '—';
  }
  return span('path', shortenPath(value), value);
};

const attachChip = (row: RequestRow): string => {
  if (typeof row.attachedTo !== 'string') {
    return '';
  }
  const mode = typeof row.attachMode === 'string' ? ` ${escapeHtml(row.attachMode)}` : '';
  return `<span class="chip">→ ${escapeHtml(row.attachedTo)}${mode}</span>`;
};

const commandCell = (row: RequestRow): string => {
  const requested = argvText(row.argv);
  const main = span('cmd', requested, argvTitle(row.argv));
  const ranAs = ranAsFor(row.argv, row.execArgv);
  if (ranAs === null) {
    return main;
  }
  const packages =
    ranAs.extraPackages > 0
      ? ` <span class="pkgcount">(+${ranAs.extraPackages} pkg${ranAs.extraPackages === 1 ? '' : 's'})</span>`
      : '';
  return (
    `${main}<div class="ranas">ran as: ` +
    `${span('cmd', ranAs.command, ranAs.command)}${packages}</div>`
  );
};

const durationCell = (value: unknown): string =>
  typeof value === 'number' ? formatMs(value) : '—';

const ticketCell = (value: unknown): string =>
  value == null ? '—' : span('ticket', String(value));

const whoCell = (row: RequestRow): string => {
  const host = typeof row.host === 'string' ? row.host : null;
  const session = typeof row.session === 'string' ? row.session : null;
  if (host === null && session === null) {
    return '—';
  }
  const label = session === null || session === host ? (host ?? '') : `${host ?? '?'} · ${session}`;
  return span('who', label, label);
};

const progressCell = (sinceMs: unknown, estimateMs: unknown, nowMs: number): string => {
  if (typeof sinceMs !== 'number') {
    return '—';
  }
  const elapsed = span('dur', formatMs(Math.max(0, nowMs - sinceMs)));
  return typeof estimateMs === 'number' && estimateMs > 0
    ? `${elapsed} <span class="est">/ ~${escapeHtml(formatMs(estimateMs))}</span>`
    : elapsed;
};

const requestCells = (row: RequestRow): readonly string[] => [
  ticketCell(row.ticket),
  commandCell(row),
  pathCell(row.workspaceRoot),
  whoCell(row),
];

const render = (structured: StructuredContent | null): void => {
  const nowMs = Date.now();
  const active = arrayOrEmpty<RequestRow>(structured?.active);
  const recent = arrayOrEmpty<RequestRow>(structured?.recent);
  const lanes = arrayOrEmpty<LaneRow>(structured?.lanes);
  const running = active.filter((row) => row.status === 'running');
  const queued = active.filter((row) => row.status === 'queued' || row.status === 'requested');
  const attached = active.filter((row) => typeof row.attachedTo === 'string');
  const maxConcurrent = typeof structured?.maxConcurrent === 'number' ? structured.maxConcurrent : 0;

  contentionEl.innerHTML =
    stat('daemon', structured?.daemon === 'running' ? 'up' : 'down') +
    stat('pid', structured?.pid == null ? '—' : String(structured.pid)) +
    stat('queued', String(queued.length)) +
    stat('attached', String(attached.length)) +
    admissionMeter(running.length, maxConcurrent);

  inflightEl.innerHTML = table(
    ['ticket', 'command', 'workspace', 'who', 'elapsed'],
    running.map((row) => [
      ...requestCells(row),
      progressCell(row.startedAtMs ?? row.createdAtMs, row.estimateMs, nowMs),
    ]),
  );

  const queueRows = queued.concat(attached.filter((row) => row.status !== 'running'));
  queueEl.innerHTML = table(
    ['ticket', 'command', 'workspace', 'who', 'waiting', 'attached'],
    queueRows.map((row) => [
      ...requestCells(row),
      progressCell(row.createdAtMs, row.estimateMs, nowMs),
      attachChip(row) || '—',
    ]),
  );

  const activeLanes = lanes.filter(
    (lane) =>
      (typeof lane.queued === 'number' && lane.queued > 0) ||
      typeof lane.runningTicket === 'string',
  );
  lanesEl.innerHTML = table(
    ['workspace', 'running', 'queued'],
    activeLanes.map((lane) => [
      pathCell(lane.workspaceRoot),
      ticketCell(typeof lane.runningTicket === 'string' ? lane.runningTicket : null),
      typeof lane.queued === 'number' ? escapeHtml(String(lane.queued)) : '—',
    ]),
  );

  const finished = recent.filter(
    (row) => typeof row.status === 'string' && terminalStatuses.has(row.status),
  ).slice(0, 20);
  historyEl.innerHTML = table(
    ['ticket', 'status', 'who', 'age', 'wait', 'run', 'command'],
    finished.map((row) => [
      ticketCell(row.ticket),
      pill(row.status),
      whoCell(row),
      typeof row.createdAtMs === 'number' ? relativeTime(row.createdAtMs, nowMs) : '—',
      durationCell(row.waitMs),
      durationCell(row.runMs),
      commandCell(row) + attachChip(row),
    ]),
  );

  setCount(
    'count-lanes',
    activeLanes.length === lanes.length
      ? lanes.length
      : `${activeLanes.length} active · ${lanes.length} seen`,
  );
  setCount('count-inflight', running.length);
  setCount('count-queue', queueRows.length);
  setCount('count-history', finished.length);
  statusEl.textContent =
    typeof structured?.summary === 'string' ? structured.summary : 'Updated.';
};

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

const applyResult = (value: unknown): void => {
  render(structuredFrom(value));
};

window.addEventListener('message', (event: MessageEvent) => {
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
    applyResult(message.params);
  }
});

let loading = false;
const load = async (): Promise<void> => {
  if (loading) {
    return;
  }
  loading = true;
  try {
    const response = await rpcRequest('tools/call', {
      arguments: { limit: 40 },
      name: 'conductor_status',
    });
    applyResult(response);
  } catch (error) {
    statusEl.textContent = `Error: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    loading = false;
  }
};

void rpcRequest('ui/initialize', {
  appCapabilities: { availableDisplayModes: ['inline'] },
  appInfo: { name: 'cargo-conductor', version: '0.1.0' },
  protocolVersion: '2026-01-26',
})
  .then(() => {
    postMessage({ jsonrpc: '2.0', method: 'ui/notifications/initialized', params: {} });
    startPolling(load, setInterval, 5_000);
  })
  .catch((error: unknown) => {
    statusEl.textContent = `Error: ${error instanceof Error ? error.message : String(error)}`;
  });

export {};
