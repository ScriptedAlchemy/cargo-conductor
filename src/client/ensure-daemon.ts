import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { version } from 'agent-bundle/meta';
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
import {
  DaemonNotReplacedError,
  exitGraceMs,
  processAlive,
  requestShutdown,
  waitForExit,
} from '../daemon/shutdown.js';
import type { ExitWaitOptions, ShutdownAck } from '../daemon/shutdown.js';
import { resolveHaulerArgv } from '../hooks/paths.js';
import { absentSocketCodes, socketErrorCode } from '../lib/socket-errors.js';
import { isHaulerInternalEnvironmentVariable } from '../lib/cargo-env.js';

export class SpawnDaemonError extends Data.TaggedError('SpawnDaemonError')<{
  readonly cause: unknown;
}> {}

export class DaemonReplacementFailedError extends Data.TaggedError('DaemonReplacementFailed')<{
  readonly cause: WaitForDaemonError;
  readonly socketPath: string;
}> {}

export type WaitForDaemonError =
  | DaemonUnreachableError
  | ControlTimeoutError
  | ConnectionClosedError;

export type EnsureDaemonError =
  | WaitForDaemonError
  | SpawnDaemonError
  | DaemonNotReplacedError
  | DaemonReplacementFailedError;

export interface EnsureDaemonDependencies extends ExitWaitOptions {
  readonly pingDaemon: (
    socketPath: string,
    timeoutMs: number,
  ) => Effect.Effect<PongMessage, WaitForDaemonError>;
  /** The graceful `shutdown` request to a daemon of another version. */
  readonly requestShutdown: (socketPath: string) => Effect.Effect<ShutdownAck>;
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
  if (script !== undefined) {
    return script;
  }
  // Routed commands render in a generated flight worker, so process.argv[1]
  // names `cargo-hauler-flight.mjs`, which is not an executable daemon entry.
  // Resolve the sibling plain script from this bundled module instead.
  for (const candidate of [
    new URL('./hauler.js', import.meta.url),
    new URL('../scripts/hauler.mjs', import.meta.url),
  ]) {
    const path = fileURLToPath(candidate);
    if (existsSync(path)) {
      return path;
    }
  }
  return process.argv[1] ?? '';
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
 * Only the daemon's own settings (`CARGO_HAULER_*`), toolchain locations,
 * locale, temp/cache paths, and network knobs for crate fetches survive.
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

export const defaultEnsureDependencies: EnsureDaemonDependencies = {
  exitGraceMs,
  pingDaemon,
  pollMs: 100,
  processAlive,
  requestShutdown,
  spawnDetachedDaemon,
  waitForDaemon,
};

/**
 * The version gate for every client read. A daemon of this build is returned,
 * an absent daemon stays absent, and a daemon from another install is replaced
 * before the caller can request or parse a versioned payload.
 *
 * One install, one version: the CLI, hooks, MCP server, and daemon always
 * ship together, so a daemon answering with another version is one left
 * running from a previous install, and it is replaced here on the next call
 * — the graceful `shutdown` request, a wait for its pid to exit, then the
 * usual detached spawn. Its in-flight tickets are not handed over: the old
 * daemon settles them itself as it shuts down (`killed`, error `daemon
 * shutdown`), exactly as under `hauler daemon restart`; only rows a daemon
 * that died without shutting down never marked are stamped `orphaned by
 * daemon restart` by the next daemon's first ledger pass. The old daemon is
 * never signalled past the request; one that outlives the grace fails this
 * call as `DaemonNotReplaced` and keeps serving.
 */
export const ensureDaemonVersion = (
  config: DaemonConfigShape = resolveDaemonConfig(),
  dependencies: EnsureDaemonDependencies = defaultEnsureDependencies,
  pingTimeoutMs = 500,
): Effect.Effect<PongMessage | null, EnsureDaemonError> =>
  Effect.gen(function* () {
    const already = yield* dependencies.pingDaemon(config.socketPath, pingTimeoutMs).pipe(
      Effect.catchTag('DaemonUnreachable', (error) =>
        daemonIsAbsent(error.cause) ? Effect.succeed(null) : Effect.fail(error),
      ),
    );
    if (already === null || already.version === version) {
      return already;
    }
    yield* dependencies.requestShutdown(config.socketPath);
    const exited = yield* waitForExit(already.pid, dependencies);
    if (!exited) {
      return yield* new DaemonNotReplacedError({
        daemon: { pid: already.pid, startedAtMs: already.startedAtMs, version: already.version },
        graceMs: dependencies.exitGraceMs,
        socketPath: config.socketPath,
      });
    }
    yield* dependencies.spawnDetachedDaemon(config);
    return yield* dependencies.waitForDaemon(config.socketPath).pipe(
      Effect.mapError(
        (cause) => new DaemonReplacementFailedError({ cause, socketPath: config.socketPath }),
      ),
    );
  });

/** The version gate plus on-demand startup when no daemon answers. */
export const ensureDaemonRunning = (
  config: DaemonConfigShape = resolveDaemonConfig(),
  dependencies: EnsureDaemonDependencies = defaultEnsureDependencies,
): Effect.Effect<PongMessage, EnsureDaemonError> =>
  ensureDaemonVersion(config, dependencies).pipe(
    Effect.flatMap((daemon) =>
      daemon === null
        ? dependencies.spawnDetachedDaemon(config).pipe(
            Effect.andThen(dependencies.waitForDaemon(config.socketPath)),
          )
        : Effect.succeed(daemon),
    ),
  );
