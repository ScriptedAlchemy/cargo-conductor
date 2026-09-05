import { createServer, type Socket } from 'node:net';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { version } from 'agent-bundle/meta';
import { describe, expect, it } from 'effect-rstest';

import { appendHookRecord, hookEventsFileName } from '../src/hooks/record.js';
import { probeActiveBuilds } from '../src/hooks/probe.js';

const withTempDir = async <A>(use: (directory: string) => Promise<A>): Promise<A> => {
  const directory = mkdtempSync(join(tmpdir(), 'cc-hook-io-'));
  try {
    return await use(directory);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
};

const listenStatus = (
  socketPath: string,
  report: { readonly active: readonly unknown[]; readonly lanes: readonly unknown[] },
): Promise<{ readonly close: () => Promise<void> }> =>
  new Promise((resolve, reject) => {
    const server = createServer((socket) => {
      socket.on('data', (chunk: Buffer) => {
        const message = JSON.parse(chunk.toString('utf8')) as { readonly id: string; readonly type: string };
        if (message.type === 'ping') {
          socket.end(
            `${JSON.stringify({ id: message.id, pid: process.pid, startedAtMs: 1, type: 'pong', version })}\n`,
          );
          return;
        }
        socket.end(
          `${JSON.stringify({
            id: 'hook-status',
            report: {
              active: report.active,
              lanes: report.lanes,
              maxConcurrent: 5,
              pid: 1,
              recent: [],
              socketPath,
              startedAtMs: 1,
            },
            type: 'status-result',
          })}\n`,
        );
      });
    });
    server.on('error', reject);
    server.listen(socketPath, () => {
      resolve({
        close: () =>
          new Promise((closeResolve, closeReject) => {
            server.close((error) => {
              if (error) {
                closeReject(error);
                return;
              }
              closeResolve();
            });
          }),
      });
    });
  });

/** Accepts connections and swallows every request, like a daemon whose event loop is saturated. */
const listenSilent = (socketPath: string): Promise<{ readonly close: () => Promise<void> }> =>
  new Promise((resolve, reject) => {
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    server.on('error', reject);
    server.listen(socketPath, () => {
      resolve({
        close: () =>
          new Promise((closeResolve, closeReject) => {
            for (const socket of sockets) {
              socket.destroy();
            }
            server.close((error) => {
              if (error) {
                closeReject(error);
                return;
              }
              closeResolve();
            });
          }),
      });
    });
  });

describe('hook recorder', () => {
  it('appends a JSON line under the hauler state dir', async () => {
    await withTempDir(async (directory) => {
      appendHookRecord(
        {
          atMs: 10,
          command: 'cargo test',
          host: 'claude',
          outcome: 'continue',
          phase: 'afterTool',
          session: 'sess-1',
        },
        directory,
      );
      expect(readFileSync(join(directory, hookEventsFileName), 'utf8')).toBe(
        `${JSON.stringify({
          atMs: 10,
          command: 'cargo test',
          host: 'claude',
          outcome: 'continue',
          phase: 'afterTool',
          session: 'sess-1',
        })}\n`,
      );
    });
  });
});

describe('daemon probe', () => {
  it('reports active when the daemon has running work', async () => {
    await withTempDir(async (directory) => {
      const socketPath = join(directory, 'daemon.sock');
      const server = await listenStatus(socketPath, { active: [{ ticket: 'cc-1' }], lanes: [] });
      try {
        await expect(probeActiveBuilds(socketPath, 500)).resolves.toBe('active');
      } finally {
        await server.close();
      }
    });
  });

  it('reports active when a lane has queued work', async () => {
    await withTempDir(async (directory) => {
      const socketPath = join(directory, 'daemon.sock');
      const server = await listenStatus(socketPath, { active: [], lanes: [{ queued: 2, runningTicket: null }] });
      try {
        await expect(probeActiveBuilds(socketPath, 500)).resolves.toBe('active');
      } finally {
        await server.close();
      }
    });
  });

  it('reports idle when the daemon has no work', async () => {
    await withTempDir(async (directory) => {
      const socketPath = join(directory, 'daemon.sock');
      const server = await listenStatus(socketPath, { active: [], lanes: [] });
      try {
        await expect(probeActiveBuilds(socketPath, 500)).resolves.toBe('idle');
      } finally {
        await server.close();
      }
    });
  });

  it('reports absent when no socket exists or nothing listens on it', async () => {
    await expect(probeActiveBuilds(join(tmpdir(), 'cc-missing-daemon.sock'), 100)).resolves.toBe('absent');
    await withTempDir(async (directory) => {
      const socketPath = join(directory, 'daemon.sock');
      const server = await listenStatus(socketPath, { active: [], lanes: [] });
      await server.close();
      // The socket file may linger after close; connecting yields ECONNREFUSED.
      await expect(probeActiveBuilds(socketPath, 100)).resolves.toBe('absent');
    });
  });

  it('reports busy when the daemon accepts but does not answer in time', async () => {
    await withTempDir(async (directory) => {
      const socketPath = join(directory, 'daemon.sock');
      const server = await listenSilent(socketPath);
      try {
        await expect(probeActiveBuilds(socketPath, 50)).resolves.toBe('busy');
      } finally {
        await server.close();
      }
    });
  });
});
