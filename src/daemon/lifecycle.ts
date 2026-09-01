import { randomUUID } from 'node:crypto';

import * as Cause from 'effect/Cause';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Fiber from 'effect/Fiber';

import { ensureDaemonRunning } from '../client/ensure-daemon.js';
import { loadConductorSnapshot } from '../query.js';

import { resolveDaemonConfig } from './config.js';
import type { DaemonConfigShape } from './config.js';
import { requestOverSocket } from './control.js';
import { runDaemon } from './main.js';
import type { StatusReport } from './protocol.js';

export const daemonSubcommands = ['run', 'start', 'stop', 'status'] as const;
export type DaemonSubcommand = (typeof daemonSubcommands)[number];

export interface DaemonControlResult {
  readonly message: string;
  readonly operation: 'daemon';
  readonly pid: number | null;
  readonly report: StatusReport | null;
  readonly running: boolean;
  readonly socketPath: string;
  readonly subcommand: DaemonSubcommand;
}

const shortId = (): string => randomUUID().slice(0, 8);

const isSubcommand = (value: string): value is DaemonSubcommand =>
  (daemonSubcommands as readonly string[]).includes(value);

export const parseDaemonSubcommand = (argv: readonly string[]): DaemonSubcommand => {
  const subcommand = argv[0];
  if (subcommand === undefined || !isSubcommand(subcommand)) {
    throw new Error('daemon requires one of: run, start, stop, status');
  }
  if (argv.length > 1) {
    throw new Error(`daemon ${subcommand} does not accept extra arguments`);
  }
  return subcommand;
};

const result = (
  config: DaemonConfigShape,
  subcommand: DaemonSubcommand,
  fields: Omit<DaemonControlResult, 'operation' | 'socketPath' | 'subcommand'>,
): DaemonControlResult => ({
  ...fields,
  operation: 'daemon',
  socketPath: config.socketPath,
  subcommand,
});

export const startDaemon = (
  config: DaemonConfigShape = resolveDaemonConfig(),
): Effect.Effect<DaemonControlResult> =>
  ensureDaemonRunning(config).pipe(
    Effect.map((pong) =>
      result(config, 'start', {
        message: `cargo-conductor daemon started (pid ${pong.pid})`,
        pid: pong.pid,
        report: null,
        running: true,
      }),
    ),
    Effect.catchAll(() =>
      Effect.succeed(
        result(config, 'start', {
          message: `cargo-conductor daemon did not come up; check ${config.logPath}`,
          pid: null,
          report: null,
          running: false,
        }),
      ),
    ),
  );

export const stopDaemon = (
  config: DaemonConfigShape = resolveDaemonConfig(),
): Effect.Effect<DaemonControlResult> =>
  requestOverSocket({
    isTerminal: (message) => message.type === 'shutting-down',
    message: { id: shortId(), type: 'shutdown' },
    socketPath: config.socketPath,
    timeoutMs: 5_000,
  }).pipe(
    Effect.map(() =>
      result(config, 'stop', {
        message: 'cargo-conductor daemon stopped',
        pid: null,
        report: null,
        running: false,
      }),
    ),
    Effect.catchTags({
      ConnectionClosed: () =>
        Effect.succeed(
          result(config, 'stop', {
            message: 'cargo-conductor daemon stopped',
            pid: null,
            report: null,
            running: false,
          }),
        ),
      ControlTimeout: () =>
        Effect.succeed(
          result(config, 'stop', {
            message: 'cargo-conductor daemon did not acknowledge the shutdown request',
            pid: null,
            report: null,
            running: false,
          }),
        ),
      DaemonUnreachable: () =>
        Effect.succeed(
          result(config, 'stop', {
            message: 'cargo-conductor daemon is not running',
            pid: null,
            report: null,
            running: false,
          }),
        ),
    }),
  );

export const statusDaemon = (
  config: DaemonConfigShape = resolveDaemonConfig(),
): Effect.Effect<DaemonControlResult> =>
  loadConductorSnapshot({ config }).pipe(
    Effect.map((snapshot) =>
      result(config, 'status', {
        message: snapshot.summary,
        pid: snapshot.pid,
        report:
          snapshot.daemon === 'running'
            ? {
                active: snapshot.active,
                lanes: snapshot.lanes,
                maxConcurrent: snapshot.maxConcurrent ?? 5,
                pid: snapshot.pid ?? 0,
                recent: snapshot.recent,
                socketPath: snapshot.socketPath,
                startedAtMs: snapshot.startedAtMs ?? 0,
              }
            : null,
        running: snapshot.daemon === 'running',
      }),
    ),
  );

export const runForegroundDaemon = (
  config: DaemonConfigShape = resolveDaemonConfig(),
): Promise<DaemonControlResult> => {
  const program = runDaemon(config);
  const fiber = Effect.runFork(program);
  const interrupt = (): void => {
    Effect.runFork(Fiber.interruptFork(fiber));
  };
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  return Effect.runPromise(Fiber.await(fiber)).then((exit) => {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
    if (Exit.isSuccess(exit)) {
      const outcome = exit.value;
      return result(config, 'run', {
        message: outcome,
        pid: outcome === 'already-running' ? null : process.pid,
        report: null,
        running: outcome === 'already-running',
      });
    }
    if (Cause.isInterruptedOnly(exit.cause)) {
      return result(config, 'run', {
        message: 'completed',
        pid: process.pid,
        report: null,
        running: false,
      });
    }
    return result(config, 'run', {
      message: Cause.pretty(exit.cause),
      pid: process.pid,
      report: null,
      running: false,
    });
  });
};

export const runDaemonControl = (
  subcommand: DaemonSubcommand,
  config: DaemonConfigShape = resolveDaemonConfig(),
): Promise<DaemonControlResult> => {
  switch (subcommand) {
    case 'run':
      return runForegroundDaemon(config);
    case 'start':
      return Effect.runPromise(startDaemon(config));
    case 'stop':
      return Effect.runPromise(stopDaemon(config));
    case 'status':
      return Effect.runPromise(statusDaemon(config));
    default: {
      const exhaustive: never = subcommand;
      return Promise.reject(new Error(`Unhandled daemon subcommand: ${String(exhaustive)}`));
    }
  }
};
