import { createConnection } from 'node:net';

import { resolveHookSocketPath } from './paths.js';

const defaultTimeoutMs = 250;

interface StatusLike {
  readonly active?: readonly unknown[];
  readonly lanes?: readonly { readonly queued?: number; readonly runningTicket?: string | null }[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const reportHasActive = (report: StatusLike): boolean => {
  if ((report.active?.length ?? 0) > 0) {
    return true;
  }
  return (report.lanes ?? []).some(
    (lane) => (lane.queued ?? 0) > 0 || (lane.runningTicket !== undefined && lane.runningTicket !== null),
  );
};

/**
 * Lean unix-socket status probe. `true` when the daemon has queued/running
 * work, `false` when it is idle, `null` when the socket cannot be reached.
 */
export const probeActiveBuilds = (
  socketPath: string = resolveHookSocketPath(),
  timeoutMs: number = defaultTimeoutMs,
): Promise<boolean | null> =>
  new Promise((resolve) => {
    let settled = false;
    const finish = (value: boolean | null): void => {
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
      socket.write(`${JSON.stringify({ id: 'hook-status', limit: 1, type: 'status' })}\n`);
    });
    socket.on('data', (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      const lines = Buffer.concat(chunks).toString('utf8').split('\n');
      for (const line of lines) {
        if (line.trim().length === 0) {
          continue;
        }
        try {
          const message = JSON.parse(line) as { readonly report?: StatusLike; readonly type?: string };
          if (message.type === 'status-result' && isRecord(message.report)) {
            clearTimeout(timer);
            socket.end();
            finish(reportHasActive(message.report));
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
      finish(null);
    });
  });
