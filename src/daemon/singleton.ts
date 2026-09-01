import { mkdir, writeFile } from 'node:fs/promises';

import * as Data from 'effect/Data';
import * as Deferred from 'effect/Deferred';
import * as Effect from 'effect/Effect';
import * as Fiber from 'effect/Fiber';
import type * as Scope from 'effect/Scope';
import { lock } from 'proper-lockfile';

import { DaemonConfig } from './config.js';

export class DaemonAlreadyRunningError extends Data.TaggedError('DaemonAlreadyRunning')<{
  readonly lockTargetPath: string;
}> {}

export class SingletonLockError extends Data.TaggedError('SingletonLockError')<{
  readonly cause: unknown;
}> {}

const staleMs = 15_000;
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
        `cargo-conductor: singleton lock compromised: ${error.message}\n`,
      );
      dependencies.setExitCode(1);
      Deferred.unsafeDone(fatalShutdown, Effect.succeed(error));
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
  };
};

export const acquireSingletonLock: Effect.Effect<
  void,
  DaemonAlreadyRunningError | SingletonLockError,
  DaemonConfig | Scope.Scope
> = Effect.gen(function* () {
  const config = yield* DaemonConfig;
  let daemonFiber: Fiber.RuntimeFiber<void, never> | undefined;
  yield* Effect.withFiberRuntime<void>((fiber) =>
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
      Effect.zipRight(Fiber.interrupt(daemonFiber)),
      Effect.asVoid,
    ),
  );
  yield* Effect.addFinalizer(() =>
    Fiber.interruptFork(fatalWatcher).pipe(
      Effect.zipRight(Effect.sync(compromise.cancelFallback)),
    ),
  );

  yield* Effect.tryPromise({
    try: async () => {
      await mkdir(config.stateDir, { recursive: true });
      await writeFile(config.lockTargetPath, '', { flag: 'a' });
    },
    catch: (cause) => new SingletonLockError({ cause }),
  });

  yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () =>
        lock(config.lockTargetPath, {
          onCompromised: compromise.onCompromised,
          stale: staleMs,
        }),
      catch: (cause) =>
        isLockedError(cause)
          ? new DaemonAlreadyRunningError({ lockTargetPath: config.lockTargetPath })
          : new SingletonLockError({ cause }),
    }),
    (release) => Effect.ignore(Effect.tryPromise(() => release())),
  );

  yield* Effect.tryPromise({
    try: () => writeFile(config.lockTargetPath, `${process.pid}\n`),
    catch: (cause) => new SingletonLockError({ cause }),
  });
});
