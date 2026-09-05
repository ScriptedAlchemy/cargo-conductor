import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { version } from 'agent-bundle/meta';
import { describe, expect, it } from 'effect-rstest';

import {
  recordDeniedAttempt,
  requestJson,
  requestOutcome,
} from '../src/hooks/rpc.js';

describe('hook RPC NDJSON framing', () => {
  it('waits for a complete response split across socket data events', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cc-hook-rpc-'));
    const socketPath = join(root, 'daemon.sock');
    const server = createServer((socket) => {
      socket.once('data', (chunk: Buffer) => {
        const message = JSON.parse(chunk.toString('utf8')) as { readonly id?: string; readonly type?: string };
        if (message.type === 'ping') {
          socket.end(
            `${JSON.stringify({ id: message.id, pid: process.pid, startedAtMs: 1, type: 'pong', version })}\n`,
          );
          return;
        }
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

  it('sends a denied-attempt audit without waiting for a version ping', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cc-hook-attempt-'));
    const socketPath = join(root, 'daemon.sock');
    let received: Record<string, unknown> | undefined;
    const server = createServer((socket) => {
      socket.once('data', (chunk: Buffer) => {
        received = JSON.parse(chunk.toString('utf8')) as Record<string, unknown>;
      });
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(socketPath, resolve);
      });
      await recordDeniedAttempt(
        {
          argv: ['cargo', 'clean'],
          cwd: '/repo',
          host: 'cursor',
          reason: 'active builds',
          session: 's1',
        },
        socketPath,
      );
      expect(received).toMatchObject({ type: 'attempt', argv: ['cargo', 'clean'] });
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      rmSync(root, { force: true, recursive: true });
    }
  });

  it('replaces a stale hook daemon before retrying the requested payload', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cc-hook-stale-'));
    const socketPath = join(root, 'daemon.sock');
    const calls: string[] = [];
    let replaced = false;
    const server = createServer((socket) => {
      socket.once('data', (chunk: Buffer) => {
        const message = JSON.parse(chunk.toString('utf8')) as {
          readonly id: string;
          readonly type: string;
        };
        calls.push(message.type);
        socket.end(
          `${JSON.stringify(
            message.type === 'ping'
              ? {
                  id: message.id,
                  pid: 1,
                  startedAtMs: 1,
                  type: 'pong',
                  version: replaced ? version : '0.0.0-previous',
                }
              : { id: message.id, requests: [], type: 'session-pending-result' },
          )}\n`,
        );
      });
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(socketPath, resolve);
      });
      const outcome = await requestOutcome(
        { id: 'pending', type: 'session-pending' },
        socketPath,
        500,
        {
          replaceStaleDaemon: async () => {
            replaced = true;
            return { detail: '', replaced: true };
          },
        },
      );
      expect(outcome).toMatchObject({
        kind: 'reply',
        message: { type: 'session-pending-result' },
      });
      expect(calls).toEqual(['ping', 'session-pending']);
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      rmSync(root, { force: true, recursive: true });
    }
  });

  it('returns replacement-failed without sending a stale daemon the payload', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cc-hook-stubborn-'));
    const socketPath = join(root, 'daemon.sock');
    const calls: string[] = [];
    const server = createServer((socket) => {
      socket.once('data', (chunk: Buffer) => {
        const message = JSON.parse(chunk.toString('utf8')) as {
          readonly id: string;
          readonly type: string;
        };
        calls.push(message.type);
        socket.end(
          `${JSON.stringify({
            id: message.id,
            pid: 1,
            startedAtMs: 1,
            type: 'pong',
            version: '0.0.0-previous',
          })}\n`,
        );
      });
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(socketPath, resolve);
      });
      const outcome = await requestOutcome(
        { id: 'pending', type: 'session-pending' },
        socketPath,
        500,
        {
          replaceStaleDaemon: async () => ({
            detail: 'old daemon still running',
            replaced: false,
          }),
        },
      );
      expect(outcome).toEqual({
        detail: 'old daemon still running',
        kind: 'replacement-failed',
      });
      expect(calls).toEqual(['ping']);
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      rmSync(root, { force: true, recursive: true });
    }
  });
});
