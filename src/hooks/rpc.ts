import { createConnection } from 'node:net';

import { LineBuffer } from '../lib/ndjson.js';

import { resolveHookSocketPath } from './paths.js';
import { isRecord } from './shared.js';

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
  readonly errorCount: number | null;
  readonly exitCode: number | null;
  readonly status: 'done' | 'failed' | 'killed';
  readonly ticket: string;
  readonly warningCount: number | null;
}

export interface DeniedAttempt {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly host: string;
  readonly reason: string;
  readonly session: string;
}

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
    errorCount: typeof value.errorCount === 'number' ? value.errorCount : null,
    exitCode: typeof value.exitCode === 'number' ? value.exitCode : null,
    status,
    ticket: value.ticket,
    warningCount: typeof value.warningCount === 'number' ? value.warningCount : null,
  };
};

/** One-shot NDJSON request/response over the daemon socket; null on any failure. */
export const requestJson = (
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
    const lines = new LineBuffer();
    const timer = setTimeout(() => {
      socket.destroy();
      finish(null);
    }, timeoutMs);
    socket.on('connect', () => {
      socket.write(`${JSON.stringify(message)}\n`);
    });
    socket.on('data', (chunk) => {
      for (const line of lines.push(chunk)) {
        try {
          const parsed = JSON.parse(line) as unknown;
          if (isRecord(parsed)) {
            clearTimeout(timer);
            socket.end();
            finish(parsed);
            return;
          }
        } catch {
          clearTimeout(timer);
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

export const recordDeniedAttempt = async (
  attempt: DeniedAttempt,
  socketPath: string = resolveHookSocketPath(),
): Promise<void> => {
  await requestJson(
    {
      argv: [...attempt.argv],
      cwd: attempt.cwd,
      host: attempt.host,
      id: `hook-attempt-${Date.now()}`,
      kind: 'denied',
      reason: attempt.reason,
      session: attempt.session,
      type: 'attempt',
    },
    socketPath,
    30,
  );
};

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
  // Await concurrently: with serial waits, one slow ticket could burn the
  // whole budget and hide another ticket that finished long ago.
  const awaited = await Promise.all(
    tickets.map(async (ticket) => {
      const message = await requestJson(
        { id: `hook-await-${ticket}`, maxWaitMs, ticket, type: 'await' },
        socketPath,
        maxWaitMs + 250,
      );
      if (message === null || message.type !== 'await-result' || message.timedOut === true) {
        return null;
      }
      return asFinished(message.request);
    }),
  );
  return awaited.filter((entry): entry is FinishedTicket => entry !== null);
};
