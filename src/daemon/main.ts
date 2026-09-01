import { rmSync } from 'node:fs';

import { NodeServices, NodeSocketServer } from '@effect/platform-node';
import * as Config from 'effect/Config';
import * as Deferred from 'effect/Deferred';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as References from 'effect/References';
import type * as SocketServer from 'effect/unstable/socket/SocketServer';

import { packageVersion } from '../lib/version.js';
import { isNamedPipePath } from '../status.js';

import { Broker, BrokerLive } from './broker.js';
import { DaemonConfig, resolveDaemonConfig } from './config.js';
import type { DaemonConfigShape } from './config.js';
import { CostModelLive } from './cost.js';
import { KacheStatusLive } from './kache-status.js';
import { Ledger, LedgerLive } from './ledger.js';
import { makeConnectionHandler } from './server.js';
import type { SingletonLockError } from './singleton.js';
import { acquireSingletonLock } from './singleton.js';
import { TopologyLive } from './topology.js';

export const daemonVersion = packageVersion;

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
  Config.logLevel('CARGO_CONDUCTOR_LOG_LEVEL').pipe(
    Effect.catch(() => Effect.succeed('Info' as const)),
    Effect.map((level) => Layer.succeed(References.MinimumLogLevel, level)),
  ),
);

const daemonProgram = Effect.gen(function* () {
  const config = yield* DaemonConfig;
  yield* acquireSingletonLock;
  // We hold the singleton lock, so an existing socket file is a leftover
  // from a crashed daemon and safe to remove. A Windows named pipe is not a
  // filesystem entry (it vanishes with its server), so there is nothing to
  // remove — and rmSync on a `\\.\pipe\` path must not run.
  const removeStaleSocket = isNamedPipePath(config.socketPath)
    ? Effect.void
    : Effect.sync(() => rmSync(config.socketPath, { force: true }));
  yield* Effect.addFinalizer(() => removeStaleSocket.pipe(Effect.ignore));
  yield* removeStaleSocket;
  const ledger = yield* Ledger;
  const reaped = yield* ledger.reapOrphans(Date.now(), 'orphaned by daemon restart');
  const broker = yield* Broker;
  const shutdownLatch = yield* Deferred.make<void>();
  const server = yield* NodeSocketServer.make({ path: config.socketPath });
  const suffix = reaped > 0 ? `, reaped ${reaped} orphaned requests` : '';
  yield* Effect.logInfo(
    `cargo-conductor daemon listening on ${config.socketPath} (pid ${process.pid}${suffix})`,
  );
  const handler = makeConnectionHandler({
    broker,
    shutdownLatch,
    startedAtMs: Date.now(),
    version: daemonVersion,
  });
  yield* Effect.raceFirst(server.run(handler), Deferred.await(shutdownLatch));
  yield* Effect.logInfo('cargo-conductor daemon shutting down');
});

export type DaemonOutcome = 'completed' | 'already-running';

/**
 * The full daemon lifecycle as one Effect: singleton lock, ledger, broker
 * lanes, unix socket server. Resolves 'completed' after a shutdown request,
 * or 'already-running' when another daemon holds the lock.
 */
export const runDaemon = (
  config: DaemonConfigShape = resolveDaemonConfig(),
): Effect.Effect<DaemonOutcome, SingletonLockError | SocketServer.SocketServerError> =>
  Effect.scoped(daemonProgram).pipe(
    // Defects escaping any daemon fiber must land in the log at Error, not
    // vanish at the default level.
    Effect.provideService(References.UnhandledLogLevel, 'Error'),
    // One merged provide: chained provides can split layer lifecycles.
    Effect.provide(Layer.mergeAll(appLayer(config), minimumLogLevelLayer)),
    Effect.as('completed' as const),
    Effect.catchTag('DaemonAlreadyRunning', () => Effect.succeed('already-running' as const)),
  );
