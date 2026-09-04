import * as Cause from 'effect/Cause';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Fiber from 'effect/Fiber';

import { ensureDaemonRunning } from '../client/ensure-daemon.js';
import { shortId } from '../lib/id.js';
import { loadHaulerSnapshot } from '../query.js';

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

const signalShutdownGraceMs = 5_000;

type ShutdownSignal = 'SIGINT' | 'SIGTERM';

export interface SignalShutdownDependencies {
  readonly forceExit: (code: number) => void;
  readonly keepAlive: () => () => void;
  readonly scheduleForceExit: (callback: () => void, delayMs: number) => () => void;
  readonly setExitCode: (code: number) => void;
}

export interface SignalShutdownController {
  readonly onSignal: (signal: ShutdownSignal) => void;
  readonly teardownComplete: () => void;
}

const defaultSignalShutdownDependencies: SignalShutdownDependencies = {
  forceExit: (code) => {
    process.exit(code);
  },
  keepAlive: () => {
    const timer = setInterval(() => undefined, 2_147_483_647);
    return () => {
      clearInterval(timer);
    };
  },
  scheduleForceExit: (callback, delayMs) => {
    const timer = setTimeout(callback, delayMs);
    return () => {
      clearTimeout(timer);
    };
  },
  setExitCode: (code) => {
    process.exitCode = code;
  },
};

export const makeSignalShutdownController = (
  interrupt: () => void,
  dependencies: SignalShutdownDependencies = defaultSignalShutdownDependencies,
): SignalShutdownController => {
  let cancelKeepAlive: (() => void) | undefined;
  let cancelFallback: (() => void) | undefined;
  let signaled = false;
  return {
    onSignal: (signal) => {
      if (signaled) {
        return;
      }
      signaled = true;
      const exitCode = signal === 'SIGINT' ? 130 : 143;
      dependencies.setExitCode(exitCode);
      cancelKeepAlive = dependencies.keepAlive();
      cancelFallback = dependencies.scheduleForceExit(
        () => dependencies.forceExit(exitCode),
        signalShutdownGraceMs,
      );
      interrupt();
    },
    teardownComplete: () => {
      cancelFallback?.();
      cancelFallback = undefined;
      cancelKeepAlive?.();
      cancelKeepAlive = undefined;
    },
  };
};

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
): Effect.Effect<DaemonControlResult> => {
  const failedStart = (): Effect.Effect<DaemonControlResult> =>
    Effect.succeed(
      result(config, 'start', {
        message: `cargo-hauler daemon did not come up; check ${config.logPath}`,
        pid: null,
        report: null,
        running: false,
      }),
    );
  return ensureDaemonRunning(config).pipe(
    Effect.map((pong) =>
      result(config, 'start', {
        message: `cargo-hauler daemon started (pid ${pong.pid})`,
        pid: pong.pid,
        report: null,
        running: true,
      }),
    ),
    Effect.catchTags({
      ConnectionClosed: failedStart,
      ControlTimeout: failedStart,
      DaemonUnreachable: failedStart,
      SpawnDaemonError: failedStart,
    }),
  );
};

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
        message: 'cargo-hauler daemon stopped',
        pid: null,
        report: null,
        running: false,
      }),
    ),
    Effect.catchTags({
      ConnectionClosed: () =>
        Effect.succeed(
          result(config, 'stop', {
            message: 'cargo-hauler daemon stopped',
            pid: null,
            report: null,
            running: false,
          }),
        ),
      ControlTimeout: () =>
        Effect.succeed(
          result(config, 'stop', {
            message: 'cargo-hauler daemon did not acknowledge the shutdown request',
            pid: null,
            report: null,
            running: false,
          }),
        ),
      DaemonUnreachable: () =>
        Effect.succeed(
          result(config, 'stop', {
            message: 'cargo-hauler daemon is not running',
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
  loadHaulerSnapshot({ config }).pipe(
    Effect.map((snapshot) =>
      result(config, 'status', {
        message: snapshot.summary,
        pid: snapshot.pid,
        report: snapshot.report,
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
    fiber.interruptUnsafe();
  };
  const shutdown = makeSignalShutdownController(interrupt);
  const onSigint = (): void => shutdown.onSignal('SIGINT');
  const onSigterm = (): void => shutdown.onSignal('SIGTERM');
  // `on`, not `once`: a repeated Ctrl-C during teardown must be swallowed by
  // the controller's `signaled` guard. With `once` the second signal reaches
  // Node's default handler, which exits without running finalizers and
  // leaves the lock and socket behind. The bounded force exit the controller
  // arms is the escape hatch for a hung teardown.
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);
  return Effect.runPromise(Fiber.await(fiber)).then((exit) => {
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
    shutdown.teardownComplete();
    if (Exit.isSuccess(exit)) {
      const outcome = exit.value;
      return result(config, 'run', {
        message: outcome,
        pid: outcome === 'already-running' ? null : process.pid,
        report: null,
        running: outcome === 'already-running',
      });
    }
    if (Cause.hasInterruptsOnly(exit.cause)) {
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
