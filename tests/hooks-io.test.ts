import { createServer } from 'node:net';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
      socket.on('data', () => {
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
  it('returns true when the daemon reports active work', async () => {
    await withTempDir(async (directory) => {
      const socketPath = join(directory, 'daemon.sock');
      const server = await listenStatus(socketPath, { active: [{ ticket: 'cc-1' }], lanes: [] });
      try {
        await expect(probeActiveBuilds(socketPath, 500)).resolves.toBe(true);
      } finally {
        await server.close();
      }
    });
  });

  it('returns false when the daemon is idle', async () => {
    await withTempDir(async (directory) => {
      const socketPath = join(directory, 'daemon.sock');
      const server = await listenStatus(socketPath, { active: [], lanes: [] });
      try {
        await expect(probeActiveBuilds(socketPath, 500)).resolves.toBe(false);
      } finally {
        await server.close();
      }
    });
  });

  it('returns null when the daemon socket is missing', async () => {
    await expect(probeActiveBuilds(join(tmpdir(), 'cc-missing-daemon.sock'), 100)).resolves.toBe(null);
  });
});
