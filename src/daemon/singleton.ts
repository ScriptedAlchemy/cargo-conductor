import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';

import * as Data from 'effect/Data';
import * as Deferred from 'effect/Deferred';
import * as Effect from 'effect/Effect';
import * as Fiber from 'effect/Fiber';
import * as Result from 'effect/Result';
import type * as Scope from 'effect/Scope';
import { lock } from 'proper-lockfile';

import { DaemonConfig } from './config.js';
import type { DaemonConfigShape } from './config.js';
import { pingDaemon } from './control.js';
import { armSharedJobserver, releaseSharedJobserver } from './jobserver.js';

export class DaemonAlreadyRunningError extends Data.TaggedError('DaemonAlreadyRunning')<{
  readonly lockTargetPath: string;
}> {}

export class SingletonLockError extends Data.TaggedError('SingletonLockError')<{
  readonly cause: unknown;
}> {}

class LockAttemptError extends Data.TaggedError('LockAttemptError')<{
  readonly cause: unknown;
}> {}

const staleMs = 15_000;
const properLockfileStaleMs = 2_147_000_000;
const forcedExitDelayMs = 5_000;

const isLockedError = (cause: unknown): boolean =>
  typeof cause === 'object' &&
  cause !== null &&
  'code' in cause &&
  (cause as { readonly code?: unknown }).code === 'ELOCKED';

export interface SingletonCompromiseDependencies {
  readonly writeStderr: (message: string) => void;
  readonly setExitCode: (code: number) => void;
  readonly forceExit: (code: number) => void;
  readonly scheduleForceExit: (callback: () => void, delayMs: number) => () => void;
}

const defaultCompromiseDependencies: SingletonCompromiseDependencies = {
  writeStderr: (message) => {
    process.stderr.write(message);
  },
  setExitCode: (code) => {
    process.exitCode = code;
  },
  forceExit: (code) => {
    process.exit(code);
  },
  scheduleForceExit: (callback, delayMs) => {
    const timer = setTimeout(callback, delayMs);
    return () => {
      clearTimeout(timer);
    };
  },
};

export interface SingletonCompromiseController {
  readonly onCompromised: (error: Error) => void;
  readonly cancelFallback: () => void;
  readonly hasOwnership: () => boolean;
}

/**
 * Losing the lock means another daemon may already be binding our socket path
 * and writing our ledger. Signal the daemon fiber so its scope can tear down;
 * a hard exit remains as a bounded fallback for hung finalizers.
 */
export const makeSingletonCompromiseController = (
  fatalShutdown: Deferred.Deferred<Error>,
  dependencies: SingletonCompromiseDependencies = defaultCompromiseDependencies,
): SingletonCompromiseController => {
  let cancelFallback: (() => void) | undefined;
  let signaled = false;
  return {
    onCompromised: (error) => {
      if (signaled) {
        return;
      }
      signaled = true;
      dependencies.writeStderr(
        `cargo-hauler: singleton lock compromised: ${error.message}\n`,
      );
      dependencies.setExitCode(1);
      Deferred.doneUnsafe(fatalShutdown, Effect.succeed(error));
      cancelFallback = dependencies.scheduleForceExit(
        () => {
          dependencies.forceExit(1);
        },
        forcedExitDelayMs,
      );
    },
    cancelFallback: () => {
      cancelFallback?.();
      cancelFallback = undefined;
    },
    hasOwnership: () => !signaled,
  };
};

type ReleaseSingletonLock = () => Promise<void>;

export interface SingletonLockDependencies {
  readonly acquire: (
    lockTargetPath: string,
    onCompromised: (error: Error) => void,
  ) => Promise<ReleaseSingletonLock>;
  readonly currentPid: number;
  readonly isProcessAlive: (pid: number) => boolean;
  readonly lockMtimeMs: (lockTargetPath: string) => Promise<number>;
  readonly now: () => number;
  readonly prepare: (stateDir: string, lockTargetPath: string) => Promise<void>;
  readonly readPid: (lockTargetPath: string) => Promise<string>;
  readonly removeOwnPid: (lockTargetPath: string, pid: number) => Promise<void>;
  readonly removeStaleLock: (lockTargetPath: string) => Promise<void>;
  readonly socketAnswers: (socketPath: string) => Effect.Effect<boolean>;
  readonly writePid: (lockTargetPath: string, pid: number) => Promise<void>;
}

const processIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return !(
      typeof cause === 'object' &&
      cause !== null &&
      'code' in cause &&
      cause.code === 'ESRCH'
    );
  }
};

const defaultLockDependencies: SingletonLockDependencies = {
  acquire: (lockTargetPath, onCompromised) =>
    lock(lockTargetPath, {
      // proper-lockfile's short stale lease is deliberately disabled here.
      // We validate the recorded owner before explicitly removing a stale
      // lock, so a moved state directory cannot split a live daemon.
      stale: properLockfileStaleMs,
      update: staleMs / 2,
      onCompromised,
    }),
  currentPid: process.pid,
  isProcessAlive: processIsAlive,
  lockMtimeMs: async (lockTargetPath) => (await stat(`${lockTargetPath}.lock`)).mtimeMs,
  now: Date.now,
  prepare: async (stateDir, lockTargetPath) => {
    await mkdir(stateDir, { recursive: true });
    await writeFile(lockTargetPath, '', { flag: 'a' });
  },
  readPid: (lockTargetPath) => readFile(lockTargetPath, 'utf8'),
  removeOwnPid: async (lockTargetPath, pid) => {
    const recorded = await readFile(lockTargetPath, 'utf8').catch(() => '');
    if (recorded.trim() === String(pid)) {
      await rm(lockTargetPath, { force: true });
    }
  },
  removeStaleLock: (lockTargetPath) =>
    rm(`${lockTargetPath}.lock`, { recursive: true, force: true }),
  socketAnswers: (socketPath) =>
    pingDaemon(socketPath, 500).pipe(
      Effect.as(true),
      Effect.catch(() => Effect.succeed(false)),
    ),
  writePid: (lockTargetPath, pid) => writeFile(lockTargetPath, `${pid}\n`),
};

const parsePid = (text: string): number | null => {
  const pid = Number(text.trim());
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
};

const singletonFailure = (message: string, cause?: unknown): SingletonLockError =>
  new SingletonLockError({
    cause: cause === undefined ? new Error(message) : new Error(message, { cause }),
  });

export const acquireSingletonLockWith = (
  config: DaemonConfigShape,
  dependencies: SingletonLockDependencies = defaultLockDependencies,
): Effect.Effect<
  void,
  DaemonAlreadyRunningError | SingletonLockError,
  Scope.Scope
> => Effect.gen(function* () {
  let daemonFiber: Fiber.Fiber<unknown, unknown> | undefined;
  yield* Effect.withFiber((fiber) =>
    Effect.sync(() => {
      daemonFiber = fiber;
    }),
  );
  if (daemonFiber === undefined) {
    return yield* Effect.die(new Error('singleton lock could not capture daemon fiber'));
  }
  const fatalShutdown = yield* Deferred.make<Error>();
  const compromise = makeSingletonCompromiseController(fatalShutdown);
  const fatalWatcher = Effect.runFork(
    Deferred.await(fatalShutdown).pipe(
      Effect.andThen(Fiber.interrupt(daemonFiber)),
      Effect.asVoid,
    ),
  );
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      fatalWatcher.interruptUnsafe();
      compromise.cancelFallback();
    }),
  );

  yield* Effect.tryPromise({
    try: () => dependencies.prepare(config.stateDir, config.lockTargetPath),
    catch: (cause) => new SingletonLockError({ cause }),
  });

  const acquireOnce = Effect.tryPromise({
    try: () => dependencies.acquire(config.lockTargetPath, compromise.onCompromised),
    catch: (cause) => new LockAttemptError({ cause }),
  });
  const firstAttempt = yield* Effect.result(acquireOnce);
  let release: ReleaseSingletonLock;
  if (Result.isSuccess(firstAttempt)) {
    release = firstAttempt.success;
  } else {
    const lockCause = firstAttempt.failure.cause;
    if (!isLockedError(lockCause)) {
      return yield* Effect.fail(new SingletonLockError({ cause: lockCause }));
    }
    if (yield* dependencies.socketAnswers(config.socketPath)) {
      return yield* Effect.fail(
        new DaemonAlreadyRunningError({ lockTargetPath: config.lockTargetPath }),
      );
    }
    const lockMtimeMs = yield* Effect.tryPromise({
      try: () => dependencies.lockMtimeMs(config.lockTargetPath),
      catch: (cause) =>
        singletonFailure('unable to inspect the held singleton lock', cause),
    });
    if (lockMtimeMs >= dependencies.now() - staleMs) {
      return yield* Effect.fail(
        singletonFailure('singleton lock is held but its daemon is not yet answering'),
      );
    }
    const recordedPid = yield* Effect.tryPromise({
      try: () => dependencies.readPid(config.lockTargetPath),
      catch: (cause) => singletonFailure('unable to read the singleton owner pid', cause),
    }).pipe(Effect.map(parsePid));
    if (recordedPid !== null && dependencies.isProcessAlive(recordedPid)) {
      return yield* Effect.fail(
        singletonFailure(
          `singleton lock owner pid ${recordedPid} is alive but its socket is not answering`,
        ),
      );
    }
    yield* Effect.tryPromise({
      try: () => dependencies.removeStaleLock(config.lockTargetPath),
      catch: (cause) =>
        singletonFailure('unable to remove the stale singleton lock', cause),
    });
    release = yield* acquireOnce.pipe(
      Effect.mapError((error) =>
        singletonFailure(
          'unable to acquire the singleton after stale-lock recovery',
          error.cause,
        ),
      ),
    );
  }

  yield* Effect.acquireRelease(
    Effect.succeed(release),
    (releaseLock) =>
      Effect.gen(function* () {
        if (compromise.hasOwnership()) {
          yield* Effect.ignore(
            Effect.tryPromise(() =>
              dependencies.removeOwnPid(
                config.lockTargetPath,
                dependencies.currentPid,
              ),
            ),
          );
        }
        yield* Effect.ignore(Effect.tryPromise(() => releaseLock()));
      }),
  );

  yield* Effect.tryPromise({
    try: () => dependencies.writePid(config.lockTargetPath, dependencies.currentPid),
    catch: (cause) => new SingletonLockError({ cause }),
  });

  // The singleton daemon owns the machine-wide cargo jobserver pool; its
  // tokens live exactly as long as this retained descriptor. Arming is a
  // best-effort optimization: on failure every spawn behaves as before.
  yield* Effect.acquireRelease(
    Effect.sync(() => armSharedJobserver({ stateDir: config.stateDir })),
    () => Effect.sync(() => releaseSharedJobserver()),
  );
});

export const acquireSingletonLock: Effect.Effect<
  void,
  DaemonAlreadyRunningError | SingletonLockError,
  DaemonConfig | Scope.Scope
> = Effect.gen(function* () {
  const config = yield* DaemonConfig;
  yield* acquireSingletonLockWith(config);
});
