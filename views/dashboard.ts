interface JsonRpcMessage {
  readonly jsonrpc?: unknown;
  readonly id?: unknown;
  readonly method?: unknown;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: { readonly message?: unknown } | null;
}

interface ToolCallResult {
  readonly structuredContent?: StructuredContent | null;
  readonly content?: readonly { readonly type?: unknown; readonly text?: unknown }[];
}

interface StructuredContent {
  readonly [key: string]: unknown;
  readonly summary?: unknown;
  readonly daemon?: unknown;
  readonly pid?: unknown;
  readonly maxConcurrent?: unknown;
  readonly lanes?: unknown;
  readonly active?: unknown;
  readonly recent?: unknown;
}

interface RequestRow {
  readonly ticket?: unknown;
  readonly status?: unknown;
  readonly session?: unknown;
  readonly host?: unknown;
  readonly argv?: unknown;
  readonly attachedTo?: unknown;
  readonly waitMs?: unknown;
  readonly runMs?: unknown;
  readonly createdAtMs?: unknown;
}

interface PendingRequest {
  readonly resolve: (value: ToolCallResult) => void;
  readonly reject: (error: unknown) => void;
}

const statusEl = document.querySelector<HTMLDivElement>('#status')!;
const contentionEl = document.querySelector<HTMLDivElement>('#contention')!;
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

const asRows = (value: unknown): readonly RequestRow[] => (Array.isArray(value) ? value : []);

const argvText = (argv: unknown): string =>
  Array.isArray(argv) ? argv.filter((part) => typeof part === 'string').join(' ') : '';

const pill = (status: unknown): string => {
  const value = typeof status === 'string' ? status : 'unknown';
  return `<span class="pill ${value}">${value}</span>`;
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
  `<div class="stat"><b>${value}</b><span>${label}</span></div>`;

const render = (structured: StructuredContent | null): void => {
  const active = asRows(structured?.active);
  const recent = asRows(structured?.recent);
  const running = active.filter((row) => row.status === 'running');
  const queued = active.filter((row) => row.status === 'queued' || row.status === 'requested');
  const attached = active.filter((row) => typeof row.attachedTo === 'string');
  const maxConcurrent = typeof structured?.maxConcurrent === 'number' ? structured.maxConcurrent : 0;
  contentionEl.innerHTML =
    stat('daemon', structured?.daemon === 'running' ? 'up' : 'down') +
    stat('pid', structured?.pid == null ? '—' : String(structured.pid)) +
    stat('running', String(running.length)) +
    stat('queued', String(queued.length)) +
    stat('attached', String(attached.length)) +
    stat('admission', String(maxConcurrent));
  inflightEl.innerHTML = table(
    ['ticket', 'status', 'command', 'session'],
    running.map((row) => [
      String(row.ticket ?? ''),
      pill(row.status),
      argvText(row.argv),
      String(row.session ?? row.host ?? ''),
    ]),
  );
  queueEl.innerHTML = table(
    ['ticket', 'status', 'command', 'attached'],
    queued.concat(attached.filter((row) => row.status !== 'running')).map((row) => [
      String(row.ticket ?? ''),
      pill(row.status),
      argvText(row.argv),
      String(row.attachedTo ?? ''),
    ]),
  );
  historyEl.innerHTML = table(
    ['ticket', 'status', 'wait', 'run', 'command'],
    recent.slice(0, 20).map((row) => [
      String(row.ticket ?? ''),
      pill(row.status),
      row.waitMs == null ? '—' : `${row.waitMs}ms`,
      row.runMs == null ? '—' : `${row.runMs}ms`,
      argvText(row.argv),
    ]),
  );
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
  if (message.id !== undefined && pending.has(message.id as number)) {
    const waiter = pending.get(message.id as number);
    if (waiter === undefined) {
      return;
    }
    pending.delete(message.id as number);
    if (message.error) {
      waiter.reject(message.error);
      return;
    }
    waiter.resolve(message.result as ToolCallResult);
    return;
  }
  if (message.method === 'ui/notifications/tool-result') {
    applyResult(message.params);
  }
});

const load = async (): Promise<void> => {
  const response = await rpcRequest('tools/call', {
    arguments: { limit: 40 },
    name: 'conductor_status',
  });
  applyResult(response);
};

void rpcRequest('ui/initialize', {
  appCapabilities: { availableDisplayModes: ['inline'] },
  appInfo: { name: 'cargo-conductor', version: '0.1.0' },
  protocolVersion: '2026-01-26',
})
  .then(() => {
    postMessage({ jsonrpc: '2.0', method: 'ui/notifications/initialized', params: {} });
    if (statusEl.textContent === 'Connecting…') {
      statusEl.textContent = 'Waiting for host…';
    }
  })
  .catch((error: unknown) => {
    statusEl.textContent = error instanceof Error ? error.message : String(error);
  });

setInterval(() => {
  void load().catch(() => undefined);
}, 15_000);

export {};
