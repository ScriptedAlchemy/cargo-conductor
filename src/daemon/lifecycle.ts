import * as Cause from 'effect/Cause';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Fiber from 'effect/Fiber';

import { ensureDaemonRunning } from '../client/ensure-daemon.js';
import { formatMs } from '../lib/format.js';
import { isRecord } from '../lib/guards.js';
import { shortId } from '../lib/id.js';
import { daemonIdentity, formatVersionSkew, type DaemonIdentity } from '../lib/version-skew.js';
import { loadHaulerSnapshot } from '../query.js';

import { resolveDaemonConfig } from './config.js';
import type { DaemonConfigShape } from './config.js';
import { requestOverSocket } from './control.js';
import { runDaemon } from './main.js';
import type { StatusReport } from './protocol.js';

export const daemonSubcommands = ['run', 'start', 'stop', 'status', 'restart'] as const;
export type DaemonSubcommand = (typeof daemonSubcommands)[number];

export interface DaemonControlResult {
  readonly message: string;
  readonly operation: 'daemon';
  readonly pid: number | null;
  /** `restart` only: the pid that was serving before, null when none was. */
  readonly previousPid?: number | null;
  readonly report: StatusReport | null;
  readonly running: boolean;
  readonly socketPath: string;
  readonly subcommand: DaemonSubcommand;
}

/**
 * The process exit code for one daemon subcommand's result, shared by the
 * `hauler` entry and the routed `cargo-hauler daemon` command.
 */
export const daemonExitCode = (result: DaemonControlResult): number => {
  switch (result.subcommand) {
    case 'run':
      return result.message === 'completed' || result.message === 'already-running' ? 0 : 1;
    case 'start':
    case 'status':
      return result.running ? 0 : 1;
    case 'stop':
      return 0;
    case 'restart':
      // Success is a running daemon that is not the one we found: a daemon
      // that outlived the grace is still serving, but was not restarted.
      return result.running && result.pid !== null && result.pid !== result.previousPid ? 0 : 1;
    default: {
      const exhaustive: never = result.subcommand;
      return exhaustive;
    }
  }
};

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
    throw new Error(`daemon requires one of: ${daemonSubcommands.join(', ')}`);
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
    // A daemon that answered with a report this build cannot read is running;
    // say which version it is and how to restart it (#75).
    Effect.catchTag('DaemonVersionSkew', (skew) =>
      Effect.succeed(
        result(config, 'status', {
          message: formatVersionSkew(skew),
          pid: skew.daemon?.pid ?? null,
          report: null,
          running: true,
        }),
      ),
    ),
  );

export interface RestartDaemonDependencies {
  /** Who answers the socket right now; null when nobody does. */
  readonly identify: (socketPath: string) => Effect.Effect<DaemonIdentity | null>;
  readonly stop: (config: DaemonConfigShape) => Effect.Effect<DaemonControlResult>;
  readonly start: (config: DaemonConfigShape) => Effect.Effect<DaemonControlResult>;
  /** Whether the process still exists (`kill -0`). */
  readonly processAlive: (pid: number) => boolean;
  /** How long the old daemon gets to exit after acknowledging the shutdown. */
  readonly exitGraceMs: number;
  readonly pollMs: number;
}

/** `kill -0`: EPERM is another user's live process, ESRCH is gone. */
const processAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isRecord(error) && error.code === 'EPERM';
  }
};

const defaultRestartDependencies: RestartDaemonDependencies = {
  exitGraceMs: signalShutdownGraceMs,
  identify: daemonIdentity,
  pollMs: 100,
  processAlive,
  start: startDaemon,
  stop: stopDaemon,
};

/** True once the pid is gone, false when it is still there at the end of the grace. */
const waitForExit = (pid: number, dependencies: RestartDaemonDependencies): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const deadline = Date.now() + dependencies.exitGraceMs;
    while (dependencies.processAlive(pid)) {
      if (Date.now() >= deadline) {
        return false;
      }
      yield* Effect.sleep(dependencies.pollMs);
    }
    return true;
  });

const versionText = (identity: DaemonIdentity | null): string =>
  identity === null ? 'version unknown' : identity.version;

/**
 * `hauler daemon restart`: the graceful stop, a wait for the old pid to
 * exit, then the usual start — so a daemon left running from an older
 * install is replaced by this build (#75). In-flight tickets are not handed
 * over: the new daemon marks them `killed` with `orphaned by daemon restart`
 * on its first ledger pass. The old daemon is never signalled past the
 * shutdown request; one that does not exit within the grace is reported,
 * not killed.
 */
export const restartDaemon = (
  config: DaemonConfigShape = resolveDaemonConfig(),
  dependencies: RestartDaemonDependencies = defaultRestartDependencies,
): Effect.Effect<DaemonControlResult> =>
  Effect.gen(function* () {
    const restart = (fields: Omit<DaemonControlResult, 'operation' | 'socketPath' | 'subcommand'>) =>
      result(config, 'restart', fields);
    const before = yield* dependencies.identify(config.socketPath);
    if (before === null) {
      const started = yield* dependencies.start(config);
      if (!started.running) {
        return restart({ ...started, previousPid: null });
      }
      const after = yield* dependencies.identify(config.socketPath);
      return restart({
        message: `cargo-hauler daemon was not running; started pid ${started.pid} (${versionText(after)})`,
        pid: started.pid,
        previousPid: null,
        report: null,
        running: true,
      });
    }
    yield* dependencies.stop(config);
    const exited = yield* waitForExit(before.pid, dependencies);
    if (!exited) {
      return restart({
        message: `cargo-hauler daemon pid ${before.pid} (${before.version}) is still running ${formatMs(dependencies.exitGraceMs)} after the shutdown request; not restarted — retry once it has exited, or stop it with \`hauler daemon stop\``,
        pid: before.pid,
        previousPid: before.pid,
        report: null,
        running: true,
      });
    }
    const started = yield* dependencies.start(config);
    if (!started.running) {
      return restart({
        ...started,
        message: `cargo-hauler daemon pid ${before.pid} (${before.version}) stopped, but ${started.message}`,
        previousPid: before.pid,
      });
    }
    const after = yield* dependencies.identify(config.socketPath);
    return restart({
      message: `cargo-hauler daemon restarted: pid ${before.pid} (${before.version}) → pid ${started.pid} (${versionText(after)})`,
      pid: started.pid,
      previousPid: before.pid,
      report: null,
      running: true,
    });
  });

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
    case 'restart':
      return Effect.runPromise(restartDaemon(config));
    default: {
      const exhaustive: never = subcommand;
      return Promise.reject(new Error(`Unhandled daemon subcommand: ${String(exhaustive)}`));
    }
  }
};
