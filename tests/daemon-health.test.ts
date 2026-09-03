import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server, type Socket } from 'node:net';

import { describe, expect, it } from 'effect-rstest';
import * as Effect from 'effect/Effect';

import { resolveDaemonConfig } from '../src/daemon/config.js';
import { probeDaemonHealth } from '../src/lib/daemon-health.js';

import { scopedDaemon, scopedTempDir } from './harness.js';

/**
 * The health probe behind the shell badge and the `haulerDaemon` provider:
 * each non-running state names its cause, and the budget bounds the socket
 * accept as well as the answer.
 */
const configAt = (stateDir: string) =>
  resolveDaemonConfig({ CARGO_HAULER_KACHE_INDEX: '', CARGO_HAULER_STATE_DIR: stateDir });

/** A state dir that exists, so a fake listener can bind the daemon socket path. */
const listenerConfig = (root: string) => {
  const stateDir = join(root, 'state');
  mkdirSync(stateDir, { recursive: true });
  return configAt(stateDir);
};

const listenOn = (path: string, server: Server): Promise<void> =>
  new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => resolve());
  });

/** A listener that accepts and never answers; `close` also destroys the connections it holds open. */
const silentServer = (): Server => {
  const connections = new Set<Socket>();
  const server = createServer((socket) => {
    connections.add(socket);
    socket.once('close', () => connections.delete(socket));
  });
  server.once('close', () => {
    for (const socket of connections) socket.destroy();
  });
  return server;
};

const closeServer = (server: Server): Promise<void> =>
  new Promise((resolve) => {
    server.close(() => resolve());
    server.emit('close');
  });

describe('probeDaemonHealth', () => {
  it('reports a missing socket as stopped without opening anything', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hauler-health-'));
    try {
      await expect(probeDaemonHealth(configAt(join(root, 'state')), { platform: 'linux' })).resolves.toEqual({
        reason: 'socket-missing',
        state: 'stopped',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports a socket nobody is listening on as connection-refused, still stopped', () =>
    Effect.gen(function* () {
      const root = yield* scopedTempDir('hauler-health-');
      const config = listenerConfig(root);
      const server = createServer();
      yield* Effect.promise(() => listenOn(config.socketPath, server));
      // Close the listener but leave the socket file behind, like a crashed daemon.
      yield* Effect.promise(() => closeServer(server));
      const health = yield* Effect.promise(() => probeDaemonHealth(config, { platform: 'linux' }));
      // Node removes the socket file on close, so the honest answer is one of the two stopped reasons.
      expect(health.state).toBe('stopped');
    }).pipe(Effect.scoped, Effect.runPromise));

  it('bounds the accept by the probe budget and reports a silent listener as unresponsive', () =>
    Effect.gen(function* () {
      const root = yield* scopedTempDir('hauler-health-');
      const config = listenerConfig(root);
      // Accepts connections and never answers: the status read must time out
      // within the budget, not the 2 s socket-open default.
      const server = silentServer();
      yield* Effect.promise(() => listenOn(config.socketPath, server));
      yield* Effect.addFinalizer(() => Effect.promise(() => closeServer(server)));
      const startedAt = Date.now();
      const health = yield* Effect.promise(() => probeDaemonHealth(config, { platform: 'linux', timeoutMs: 300 }));
      expect(Date.now() - startedAt).toBeLessThan(1_500);
      expect(health).toMatchObject({ state: 'unresponsive', timeoutMs: 300 });
    }).pipe(Effect.scoped, Effect.runPromise), 10_000);

  it.skipIf(process.getuid?.() === 0)('reports a socket it may not open as unreachable with the errno, not stopped', () =>
    Effect.gen(function* () {
      const root = yield* scopedTempDir('hauler-health-');
      const config = listenerConfig(root);
      const server = silentServer();
      yield* Effect.promise(() => listenOn(config.socketPath, server));
      yield* Effect.addFinalizer(() => Effect.promise(() => closeServer(server)));
      chmodSync(config.socketPath, 0o000);
      const health = yield* Effect.promise(() => probeDaemonHealth(config, { platform: 'linux', timeoutMs: 300 }));
      expect(health).toMatchObject({ reason: 'open-failed', state: 'unreachable' });
      expect(health.state === 'unreachable' ? health.detail : '').toContain('EACCES');
    }).pipe(Effect.scoped, Effect.runPromise), 10_000);

  it.live('reports a live broker as running with its permit, rider, queue, and lane summary', () =>
    Effect.gen(function* () {
      const fixture = yield* scopedDaemon(3);
      const health = yield* Effect.promise(() => probeDaemonHealth(fixture.config));
      expect(health).toMatchObject({
        busyLanes: 0,
        maxConcurrent: 3,
        queued: 0,
        riding: 0,
        running: 0,
        state: 'running',
      });
      expect(health.state === 'running' ? health.pid : -1).toBeGreaterThan(0);
    }));
});
