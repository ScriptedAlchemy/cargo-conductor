import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';

import { version } from 'agent-bundle/meta';

import { socketErrorCode } from '../lib/socket-errors.js';

import { asFinishedTicket, type FinishedTicket } from './finished-ticket.js';
import { resolveHaulerArgv, resolveHookSocketPath } from './paths.js';
import { isRecord } from './shared.js';

export type { FinishedTicket };

export interface PendingTicket {
  readonly createdAtMs: number;
  readonly estimateMs: number | null;
  readonly holdStop: boolean;
  readonly startedAtMs: number | null;
  readonly status: string;
  readonly ticket: string;
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

/**
 * Why a one-shot request produced no usable reply. `timeout` means the daemon
 * accepted (or is still accepting) but did not answer in time — it is alive
 * and busy. `unreachable` is a socket error before any reply, with the error
 * code so callers can tell "nothing listens" (`ECONNREFUSED`, `ENOENT`) from
 * everything else. `closed` and `malformed` mean the daemon spoke, but not a
 * JSON object.
 */
export type RequestOutcome =
  | { readonly kind: 'closed' }
  | { readonly kind: 'malformed' }
  | { readonly kind: 'reply'; readonly message: Record<string, unknown> }
  | { readonly detail: string; readonly kind: 'replacement-failed' }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'unreachable'; readonly code: string | undefined };

/**
 * Newline-splits the reply stream one decoded chunk at a time. A one-shot
 * request reads a single line, so this stays dependency-free on purpose: the
 * hook entries built from this module must not load Effect (the shared
 * `LineBuffer` does) before deciding whether a shell call concerns them.
 */
const lineSplitter = (): ((chunk: string) => string[]) => {
  let pending = '';
  return (chunk) => {
    const pieces = `${pending}${chunk}`.split('\n');
    pending = pieces.pop() ?? '';
    return pieces.filter((line) => line.trim().length > 0);
  };
};

const requestOnce = (
  message: Record<string, unknown>,
  socketPath: string,
  timeoutMs: number,
): Promise<RequestOutcome> =>
  new Promise((resolve) => {
    let settled = false;
    const finish = (value: RequestOutcome): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(value);
    };
    const socket = createConnection({ path: socketPath });
    const lines = lineSplitter();
    const timer = setTimeout(() => {
      socket.destroy();
      finish({ kind: 'timeout' });
    }, timeoutMs);
    // Decoding on the socket keeps a multi-byte character split across chunks whole.
    socket.setEncoding('utf8');
    socket.on('connect', () => {
      socket.write(`${JSON.stringify(message)}\n`);
    });
    socket.on('data', (chunk: string) => {
      for (const line of lines(chunk)) {
        try {
          const parsed: unknown = JSON.parse(line);
          if (isRecord(parsed)) {
            clearTimeout(timer);
            socket.end();
            finish({ kind: 'reply', message: parsed });
            return;
          }
        } catch {
          clearTimeout(timer);
          finish({ kind: 'malformed' });
          socket.destroy();
          return;
        }
      }
    });
    socket.on('error', (error) => {
      clearTimeout(timer);
      finish({ code: socketErrorCode(error) ?? undefined, kind: 'unreachable' });
    });
    socket.on('close', () => {
      clearTimeout(timer);
      finish({ kind: 'closed' });
    });
  });

const replaceStaleDaemon = (): Promise<{ readonly detail: string; readonly replaced: boolean }> =>
  new Promise((resolve) => {
    const [command, ...args] = resolveHaulerArgv();
    if (command === undefined) {
      resolve({ detail: 'hauler entry is unavailable', replaced: false });
      return;
    }
    const child = spawn(command, [...args, 'daemon', 'start'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
    });
    child.once('error', (error) => {
      resolve({ detail: error.message, replaced: false });
    });
    child.once('close', (code) => {
      resolve({
        detail: output.trim() || `hauler daemon start exited ${code ?? 1}`,
        replaced: code === 0,
      });
    });
  });

/**
 * One-shot hook request with the same one-version gate as the Effect client.
 * Hook fast paths stay dependency-free on Effect: on skew they delegate the
 * replacement to `hauler daemon start`, which owns the shutdown/wait/spawn
 * lifecycle, then retry the requested operation once.
 */
export const requestOutcome = async (
  message: Record<string, unknown>,
  socketPath: string,
  timeoutMs: number,
): Promise<RequestOutcome> => {
  const ping = await requestOnce(
    { id: `hook-version-${Date.now()}`, type: 'ping' },
    socketPath,
    timeoutMs,
  );
  if (ping.kind !== 'reply') {
    return ping;
  }
  if (ping.message.type !== 'pong' || typeof ping.message.version !== 'string') {
    return { kind: 'malformed' };
  }
  if (ping.message.version !== version) {
    const replacement = await replaceStaleDaemon();
    if (!replacement.replaced) {
      return { detail: replacement.detail, kind: 'replacement-failed' };
    }
  }
  return requestOnce(message, socketPath, timeoutMs);
};

/** One-shot NDJSON request/response over the daemon socket; null on any failure. */
export const requestJson = async (
  message: Record<string, unknown>,
  socketPath: string,
  timeoutMs: number,
): Promise<Record<string, unknown> | null> => {
  const outcome = await requestOutcome(message, socketPath, timeoutMs);
  return outcome.kind === 'reply' ? outcome.message : null;
};

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
    const parsed = asFinishedTicket(entry);
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
      return asFinishedTicket(message.request);
    }),
  );
  return awaited.filter((entry): entry is FinishedTicket => entry !== null);
};
