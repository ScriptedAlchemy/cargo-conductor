import { rmSync } from 'node:fs';

import { NodeContext, NodeSocketServer } from '@effect/platform-node';
import type * as SocketServer from '@effect/platform/SocketServer';
import * as Config from 'effect/Config';
import * as Deferred from 'effect/Deferred';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Logger from 'effect/Logger';
import * as LogLevel from 'effect/LogLevel';
import * as Option from 'effect/Option';

import { packageVersion } from '../lib/version.js';

import { Broker, BrokerLive } from './broker.js';
import { DaemonConfig, resolveDaemonConfig } from './config.js';
import type { DaemonConfigShape } from './config.js';
import { CostModelLive } from './cost.js';
import { Ledger, LedgerLive } from './ledger.js';
import { makeConnectionHandler } from './server.js';
import type { SingletonLockError } from './singleton.js';
import { acquireSingletonLock } from './singleton.js';
import { TopologyLive } from './topology.js';

export const daemonVersion = packageVersion;

const appLayer = (config: DaemonConfigShape) =>
  BrokerLive.pipe(
    Layer.provideMerge(CostModelLive),
    Layer.provideMerge(TopologyLive),
    Layer.provideMerge(LedgerLive),
    Layer.provideMerge(Layer.succeed(DaemonConfig, config)),
    Layer.provideMerge(NodeContext.layer),
  );

const minimumLogLevelLayer = Layer.unwrapEffect(
  Config.logLevel('CARGO_CONDUCTOR_LOG_LEVEL').pipe(
    Config.withDefault(LogLevel.Info),
    Effect.orElseSucceed(() => LogLevel.Info),
    Effect.map(Logger.minimumLogLevel),
  ),
);

const daemonProgram = Effect.gen(function* () {
  const config = yield* DaemonConfig;
  yield* acquireSingletonLock;
  // We hold the singleton lock, so an existing socket file is a leftover
  // from a crashed daemon and safe to remove.
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => rmSync(config.socketPath, { force: true })).pipe(Effect.ignore),
  );
  yield* Effect.sync(() => rmSync(config.socketPath, { force: true }));
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
    Effect.withUnhandledErrorLogLevel(Option.some(LogLevel.Error)),
    Effect.provide(appLayer(config)),
    Effect.provide(minimumLogLevelLayer),
    Effect.as('completed' as const),
    Effect.catchTag('DaemonAlreadyRunning', () => Effect.succeed('already-running' as const)),
  );
