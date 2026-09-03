import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'effect-rstest';

import { requestJson } from '../src/hooks/rpc.js';

describe('hook RPC NDJSON framing', () => {
  it('waits for a complete response split across socket data events', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cc-hook-rpc-'));
    const socketPath = join(root, 'daemon.sock');
    const server = createServer((socket) => {
      socket.once('data', () => {
        socket.write('{"type":"session-pending');
        setTimeout(() => {
          socket.end('-result","requests":[]}\n');
        }, 10);
      });
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(socketPath, resolve);
      });

      await expect(
        requestJson({ id: 'split', type: 'session-pending' }, socketPath, 500),
      ).resolves.toEqual({
        requests: [],
        type: 'session-pending-result',
      });
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      rmSync(root, { force: true, recursive: true });
    }
  });
});
