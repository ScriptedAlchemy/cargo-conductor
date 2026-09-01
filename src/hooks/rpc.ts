import { createConnection } from 'node:net';

import { resolveHookSocketPath } from './paths.js';

export interface PendingTicket {
  readonly createdAtMs: number;
  readonly estimateMs: number | null;
  readonly holdStop: boolean;
  readonly startedAtMs: number | null;
  readonly status: string;
  readonly ticket: string;
}

export interface FinishedTicket {
  readonly error: string | null;
  readonly exitCode: number | null;
  readonly status: 'done' | 'failed' | 'killed';
  readonly ticket: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const asPending = (value: unknown): PendingTicket | null => {
  if (!isRecord(value) || typeof value.ticket !== 'string') {
    return null;
  }
  return {
    createdAtMs: typeof value.createdAtMs === 'number' ? value.createdAtMs : 0,
    estimateMs: typeof value.estimateMs === 'number' ? value.estimateMs : null,
    holdStop: value.holdStop === true,
    startedAtMs: typeof value.startedAtMs === 'number' ? value.startedAtMs : null,
    status: typeof value.status === 'string' ? value.status : 'queued',
    ticket: value.ticket,
  };
};

const asFinished = (value: unknown): FinishedTicket | null => {
  if (!isRecord(value) || typeof value.ticket !== 'string') {
    return null;
  }
  const status = value.status;
  if (status !== 'done' && status !== 'failed' && status !== 'killed') {
    return null;
  }
  return {
    error: typeof value.error === 'string' ? value.error : null,
    exitCode: typeof value.exitCode === 'number' ? value.exitCode : null,
    status,
    ticket: value.ticket,
  };
};

const requestJson = (
  message: Record<string, unknown>,
  socketPath: string,
  timeoutMs: number,
): Promise<Record<string, unknown> | null> =>
  new Promise((resolve) => {
    let settled = false;
    const finish = (value: Record<string, unknown> | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(value);
    };
    const socket = createConnection({ path: socketPath });
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      socket.destroy();
      finish(null);
    }, timeoutMs);
    socket.on('connect', () => {
      socket.write(`${JSON.stringify(message)}\n`);
    });
    socket.on('data', (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      const lines = Buffer.concat(chunks).toString('utf8').split('\n');
      for (const line of lines) {
        if (line.trim().length === 0) {
          continue;
        }
        try {
          const parsed = JSON.parse(line) as unknown;
          if (isRecord(parsed)) {
            clearTimeout(timer);
            socket.end();
            finish(parsed);
            return;
          }
        } catch {
          finish(null);
          socket.destroy();
          return;
        }
      }
    });
    socket.on('error', () => {
      clearTimeout(timer);
      finish(null);
    });
    socket.on('close', () => {
      clearTimeout(timer);
      if (!settled) {
        finish(null);
      }
    });
  });

export const listSessionPending = async (
  session: string,
  socketPath: string = resolveHookSocketPath(),
): Promise<readonly PendingTicket[]> => {
  const message = await requestJson(
    { id: 'hook-pending', session, type: 'session-pending' },
    socketPath,
    500,
  );
  if (message === null || message.type !== 'session-pending-result' || !Array.isArray(message.requests)) {
    throw new Error('session-pending unavailable');
  }
  return message.requests.flatMap((entry) => {
    const parsed = asPending(entry);
    return parsed === null ? [] : [parsed];
  });
};

export const listSessionCompleted = async (
  session: string,
  sinceMs: number,
  socketPath: string = resolveHookSocketPath(),
): Promise<readonly FinishedTicket[]> => {
  const message = await requestJson(
    { id: 'hook-completed', session, sinceMs, type: 'session-completed' },
    socketPath,
    500,
  );
  if (message === null || message.type !== 'session-completed-result' || !Array.isArray(message.requests)) {
    throw new Error('session-completed unavailable');
  }
  return message.requests.flatMap((entry) => {
    const parsed = asFinished(entry);
    return parsed === null ? [] : [parsed];
  });
};

export const waitForTickets = async (
  tickets: readonly string[],
  maxWaitMs: number,
  socketPath: string = resolveHookSocketPath(),
): Promise<readonly FinishedTicket[]> => {
  const finished: FinishedTicket[] = [];
  const deadline = Date.now() + maxWaitMs;
  for (const ticket of tickets) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      break;
    }
    const message = await requestJson(
      { id: `hook-await-${ticket}`, maxWaitMs: remaining, ticket, type: 'await' },
      socketPath,
      remaining + 250,
    );
    if (message === null || message.type !== 'await-result' || message.timedOut === true) {
      continue;
    }
    const parsed = asFinished(message.request);
    if (parsed !== null) {
      finished.push(parsed);
    }
  }
  return finished;
};
