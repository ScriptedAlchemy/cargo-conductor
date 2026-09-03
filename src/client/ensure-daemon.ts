import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';

import * as Data from 'effect/Data';
import * as Effect from 'effect/Effect';
import * as Schedule from 'effect/Schedule';

import { resolveDaemonConfig } from '../daemon/config.js';
import type { DaemonConfigShape } from '../daemon/config.js';
import { pingDaemon } from '../daemon/control.js';
import type {
  ConnectionClosedError,
  ControlTimeoutError,
  DaemonUnreachableError,
} from '../daemon/control.js';
import type { PongMessage } from '../daemon/protocol.js';
import { resolveHaulerArgv } from '../hooks/paths.js';

export class SpawnDaemonError extends Data.TaggedError('SpawnDaemonError')<{
  readonly cause: unknown;
}> {}

export type WaitForDaemonError =
  | DaemonUnreachableError
  | ControlTimeoutError
  | ConnectionClosedError;

export type EnsureDaemonError = WaitForDaemonError | SpawnDaemonError;

export interface EnsureDaemonDependencies {
  readonly pingDaemon: (
    socketPath: string,
    timeoutMs: number,
  ) => Effect.Effect<PongMessage, WaitForDaemonError>;
  readonly spawnDetachedDaemon: (
    config: DaemonConfigShape,
  ) => Effect.Effect<void, SpawnDaemonError>;
  readonly waitForDaemon: (
    socketPath: string,
  ) => Effect.Effect<PongMessage, WaitForDaemonError>;
}

export interface SpawnDetachedDaemonDependencies {
  readonly spawnProcess: (
    command: string,
    args: readonly string[],
    options: SpawnOptions,
  ) => ChildProcess;
}

const defaultSpawnDependencies: SpawnDetachedDaemonDependencies = {
  spawnProcess: (command, args, options) => spawn(command, [...args], options),
};

const absentSocketCodes = new Set(['ECONNREFUSED', 'ENOENT']);

const errorCode = (cause: unknown): string | null => {
  let current = cause;
  // Walk both `cause` chains and v4 Socket error wrappers: SocketError nests
  // the syscall error (with its ECONNREFUSED/ENOENT code) under `.reason`,
  // not `.cause` — missing that made a dead socket look like a non-absent
  // failure, so clients never spawned the daemon.
  for (let depth = 0; depth < 6; depth += 1) {
    if (typeof current !== 'object' || current === null) {
      return null;
    }
    if ('code' in current && typeof current.code === 'string') {
      return current.code;
    }
    if ('cause' in current && current.cause !== undefined && current.cause !== null) {
      current = current.cause;
      continue;
    }
    if ('reason' in current && current.reason !== undefined && current.reason !== null) {
      current = current.reason;
      continue;
    }
    return null;
  }
  return null;
};

/** Exported for the regression test against real socket error shapes. */
export const daemonIsAbsent = (cause: unknown): boolean => {
  const code = errorCode(cause);
  return code !== null && absentSocketCodes.has(code);
};

export const waitForDaemon = (
  socketPath: string,
): Effect.Effect<PongMessage, WaitForDaemonError> =>
  pingDaemon(socketPath, 1_000).pipe(
    Effect.retry(
      Schedule.spaced('150 millis').pipe(
        Schedule.jittered,
        Schedule.upTo({ duration: '10 seconds' }),
      ),
    ),
  );

/**
 * The entry that understands `daemon run`: the artifact's `hauler.mjs` when
 * a host injected the plugin root (an MCP server or hook entry re-spawning
 * itself would not), otherwise the running executable.
 */
const defaultDaemonEntry = (): string => {
  const [, script] = resolveHaulerArgv();
  return script ?? process.argv[1] ?? '';
};

export const spawnDetachedDaemon = (
  config: DaemonConfigShape,
  entryPath: string = defaultDaemonEntry(),
  dependencies: SpawnDetachedDaemonDependencies = defaultSpawnDependencies,
): Effect.Effect<void, SpawnDaemonError> =>
  Effect.acquireUseRelease(
    Effect.try({
      try: () => {
        mkdirSync(config.stateDir, { recursive: true });
        return openSync(config.logPath, 'a');
      },
      catch: (cause) => new SpawnDaemonError({ cause }),
    }),
    (logFd) =>
      Effect.try({
        try: () => {
          const child = dependencies.spawnProcess(
            process.execPath,
            [entryPath, 'daemon', 'run'],
            {
              detached: true,
              env: { ...process.env, CARGO_HAULER_STATE_DIR: config.stateDir },
              stdio: ['ignore', logFd, logFd],
            },
          );
          child.unref();
        },
        catch: (cause) => new SpawnDaemonError({ cause }),
      }),
    (logFd) =>
      Effect.sync(() => {
        closeSync(logFd);
      }),
  );

export const ensureDaemonRunning = (
  config: DaemonConfigShape = resolveDaemonConfig(),
  dependencies: EnsureDaemonDependencies = {
    pingDaemon,
    spawnDetachedDaemon,
    waitForDaemon,
  },
): Effect.Effect<PongMessage, EnsureDaemonError> =>
  Effect.gen(function* () {
    const already = yield* dependencies.pingDaemon(config.socketPath, 500).pipe(
      Effect.catchTag('DaemonUnreachable', (error) =>
        daemonIsAbsent(error.cause) ? Effect.succeed(null) : Effect.fail(error),
      ),
    );
    if (already !== null) {
      return already;
    }
    yield* dependencies.spawnDetachedDaemon(config);
    return yield* dependencies.waitForDaemon(config.socketPath);
  });
