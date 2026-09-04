import { rmSync } from 'node:fs';
import { rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { NodeServices, NodeSocketServer } from '@effect/platform-node';
import { version } from 'agent-bundle/meta';
import * as Config from 'effect/Config';
import * as Deferred from 'effect/Deferred';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as References from 'effect/References';
import type * as Scope from 'effect/Scope';
import type * as SocketServer from 'effect/unstable/socket/SocketServer';

import { isNamedPipePath } from '../status.js';

import { Broker, BrokerLive } from './broker.js';
import { DaemonConfig, resolveDaemonConfig } from './config.js';
import type { DaemonConfigShape } from './config.js';
import { CostModelLive } from './cost.js';
import { KacheStatusLive } from './kache-status.js';
import { Ledger, LedgerLive } from './ledger.js';
import { orphanedByRestartError } from './protocol.js';
import { makeConnectionHandler } from './server.js';
import type { SingletonLockError } from './singleton.js';
import { acquireSingletonLockWith } from './singleton.js';
import {
  monitorSocketOwnership,
  readSocketIdentity,
  removeSocketIfOwned,
  SocketOwnershipLostError,
} from './socket-ownership.js';
import type { SocketIdentity } from './socket-ownership.js';
import { TopologyLive } from './topology.js';

export const daemonVersion = version;

const appLayer = (config: DaemonConfigShape) =>
  BrokerLive.pipe(
    Layer.provideMerge(CostModelLive),
    Layer.provideMerge(KacheStatusLive),
    Layer.provideMerge(TopologyLive),
    Layer.provideMerge(LedgerLive),
    Layer.provideMerge(Layer.succeed(DaemonConfig, config)),
    Layer.provideMerge(NodeServices.layer),
  );

const minimumLogLevelLayer = Layer.unwrap(
  Config.logLevel('CARGO_HAULER_LOG_LEVEL').pipe(
    Config.orElse(() => Config.logLevel('CARGO_CONDUCTOR_LOG_LEVEL')),
    Effect.orElseSucceed(() => 'Info' as const),
    Effect.map((level) => Layer.succeed(References.MinimumLogLevel, level)),
  ),
);

export interface BoundDaemonSocket {
  /** `null` for a Windows named pipe, which has no filesystem identity. */
  readonly identity: SocketIdentity | null;
  readonly server: SocketServer.SocketServer['Service'];
}

/**
 * Bind the daemon's control socket and publish it at `socketPath`.
 *
 * libuv unlinks a unix server's listen path by name, unconditionally, when
 * the server closes. Listening on the canonical path directly would let a
 * daemon that lost ownership delete the replacement daemon's socket on its
 * way out — the exact case `monitorSocketOwnership` exists for. So the server
 * listens on a pid-unique sibling name and that entry is renamed over the
 * canonical path once listening (rename is atomic: clients see either no
 * socket or ours). Closing then unlinks only the vacated sibling name, and
 * the inode-guarded `removeSocketIfOwned` stays the sole remover of the
 * canonical path.
 */
/**
 * The temporary name the daemon listens on before the rename. It lives in
 * the same directory (rename must not cross filesystems) and is never longer
 * than the canonical `daemon.sock`: `sun_path` allows 103 bytes on macOS, and
 * `daemonSocketPath` already sized the canonical path to fit, so a longer
 * suffix (`daemon.sock.<pid>`) failed to bind with EINVAL on deep temp roots.
 */
export const socketListenPath = (socketPath: string, pid: number): string =>
  join(dirname(socketPath), `.${pid}.s`);

export const bindDaemonSocket = (
  socketPath: string,
): Effect.Effect<
  BoundDaemonSocket,
  SocketOwnershipLostError | SocketServer.SocketServerError,
  Scope.Scope
> =>
  Effect.gen(function* () {
    if (isNamedPipePath(socketPath)) {
      // A Windows named pipe is not a filesystem entry: nothing to rename,
      // nothing for close() to unlink.
      const server = yield* NodeSocketServer.make({ path: socketPath });
      return { identity: null, server };
    }
    const listenPath = socketListenPath(socketPath, process.pid);
    yield* Effect.sync(() => rmSync(listenPath, { force: true }));
    const server = yield* NodeSocketServer.make({ path: listenPath });
    // Stat before the rename: the inode is ours for certain, whereas the
    // canonical path could already name a competing daemon's socket.
    const identity = yield* Effect.tryPromise({
      try: () => readSocketIdentity(listenPath),
      catch: (cause) => new SocketOwnershipLostError({ cause, socketPath }),
    });
    yield* Effect.tryPromise({
      try: () => rename(listenPath, socketPath),
      catch: (cause) => new SocketOwnershipLostError({ cause, socketPath }),
    });
    yield* Effect.addFinalizer(() =>
      Effect.ignore(Effect.tryPromise(() => removeSocketIfOwned(socketPath, identity))),
    );
    return { identity, server };
  });

const daemonProgram = Effect.gen(function* () {
  const config = yield* DaemonConfig;
  // We hold the singleton lock, so an existing socket file is a leftover
  // from a crashed daemon and safe to remove. A Windows named pipe is not a
  // filesystem entry (it vanishes with its server), so there is nothing to
  // remove — and rmSync on a `\\.\pipe\` path must not run.
  const removeStaleSocket = isNamedPipePath(config.socketPath)
    ? Effect.void
    : Effect.sync(() => rmSync(config.socketPath, { force: true }));
  yield* removeStaleSocket;
  const ledger = yield* Ledger;
  const reaped = yield* ledger.reapOrphans(Date.now(), orphanedByRestartError);
  const broker = yield* Broker;
  const shutdownLatch = yield* Deferred.make<void>();
  const { identity, server } = yield* bindDaemonSocket(config.socketPath);
  const socketOwnership =
    identity === null ? Effect.never : monitorSocketOwnership(config.socketPath, identity);
  const suffix = reaped > 0 ? `, reaped ${reaped} orphaned requests` : '';
  yield* Effect.logInfo(
    `cargo-hauler daemon listening on ${config.socketPath} (pid ${process.pid}${suffix})`,
  );
  const handler = makeConnectionHandler({
    broker,
    shutdownLatch,
    startedAtMs: Date.now(),
    version: daemonVersion,
  });
  yield* Effect.raceFirst(
    Effect.raceFirst(server.run(handler), Deferred.await(shutdownLatch)),
    socketOwnership,
  );
  yield* Effect.logInfo('cargo-hauler daemon shutting down');
});

export type DaemonOutcome = 'completed' | 'already-running';

/**
 * The full daemon lifecycle as one Effect: singleton lock, ledger, broker
 * lanes, unix socket server. Resolves 'completed' after a shutdown request,
 * or 'already-running' when another daemon holds the lock.
 */
export const runDaemon = (
  config: DaemonConfigShape = resolveDaemonConfig(),
): Effect.Effect<
  DaemonOutcome,
  SingletonLockError | SocketOwnershipLostError | SocketServer.SocketServerError
> =>
  Effect.scoped(
    Effect.gen(function* () {
      // The lock comes before the layers: building LedgerLive opens the
      // database writable, migrates, and backfills, and BrokerLive drains
      // the passthrough spool. A losing instance must do none of that, nor
      // race the live daemon's own drain. The lock's scope outlives the
      // layers, so it is released after the ledger closes.
      yield* acquireSingletonLockWith(config);
      yield* daemonProgram.pipe(Effect.provide(appLayer(config)));
    }),
  ).pipe(
    // Defects escaping any daemon fiber must land in the log at Error, not
    // vanish at the default level.
    Effect.provideService(References.UnhandledLogLevel, 'Error'),
    Effect.provide(minimumLogLevelLayer),
    Effect.as('completed' as const),
    Effect.catchTag('DaemonAlreadyRunning', () => Effect.succeed('already-running' as const)),
  );
