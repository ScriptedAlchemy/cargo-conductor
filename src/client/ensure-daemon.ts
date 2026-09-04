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
import { absentSocketCodes, socketErrorCode } from '../lib/socket-errors.js';
import { isHaulerInternalEnvironmentVariable } from '../lib/cargo-env.js';

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

/** Exported for the regression test against real socket error shapes. */
export const daemonIsAbsent = (cause: unknown): boolean => {
  const code = socketErrorCode(cause);
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

const spawnEnvExactNames = new Set([
  'ALL_PROXY',
  'CARGO_HOME',
  'HOME',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'LANG',
  'LOGNAME',
  'NO_PROXY',
  'PATH',
  'RUSTUP_HOME',
  'SHELL',
  'TMPDIR',
  'USER',
  'all_proxy',
  'http_proxy',
  'https_proxy',
  'no_proxy',
]);

const spawnEnvPrefixes = ['LC_', 'SSL_CERT_', 'XDG_'];

/**
 * The environment the detached daemon starts with. The daemon lays every
 * request's transported env over its own when it spawns cargo, so whatever
 * the first client's shell exported — `RUSTFLAGS`, `CARGO_TARGET_DIR`,
 * `RUSTC_WRAPPER`, a fd-based `MAKEFLAGS` jobserver — would otherwise become
 * the base of every other session's builds until the daemon restarts (#55).
 * Only the daemon's own settings (`CARGO_HAULER_*` and the legacy tuning
 * aliases), toolchain locations, locale, temp/cache paths, and network knobs
 * for crate fetches survive.
 */
export const daemonSpawnEnv = (
  env: Readonly<Record<string, string | undefined>>,
  stateDir: string,
): Record<string, string> => {
  const curated: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) {
      continue;
    }
    if (
      spawnEnvExactNames.has(name) ||
      isHaulerInternalEnvironmentVariable(name) ||
      spawnEnvPrefixes.some((prefix) => name.startsWith(prefix))
    ) {
      curated[name] = value;
    }
  }
  curated.CARGO_HAULER_STATE_DIR = stateDir;
  return curated;
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
          // cwd is the state dir, not the client's directory: a relative path
          // the daemon resolves must not depend on who happened to start it.
          const child = dependencies.spawnProcess(
            process.execPath,
            [entryPath, 'daemon', 'run'],
            {
              cwd: config.stateDir,
              detached: true,
              env: daemonSpawnEnv(process.env, config.stateDir),
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
