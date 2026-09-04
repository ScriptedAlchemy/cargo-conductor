import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { uptime } from 'node:os';

import * as Data from 'effect/Data';
import * as Deferred from 'effect/Deferred';
import * as Effect from 'effect/Effect';
import * as Fiber from 'effect/Fiber';
import * as Result from 'effect/Result';
import type * as Scope from 'effect/Scope';
import { lock } from 'proper-lockfile';

import { isRecord } from '../lib/guards.js';

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
/**
 * A held lock is re-examined at this cadence for `staleMs + recoveryMarginMs`:
 * long enough for an uncleanly killed daemon's lock (mtime refreshed every
 * `staleMs / 2`) to age past `staleMs`, so recovery no longer depends on the
 * first look happening to land after that.
 */
const recoveryPollMs = 1_000;
const recoveryMarginMs = 5_000;
const maxAcquireAttempts = 64;

const hasErrorCode = (cause: unknown, code: string): boolean =>
  isRecord(cause) && cause.code === code;

const isLockedError = (cause: unknown): boolean => hasErrorCode(cause, 'ELOCKED');

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

/**
 * `kill(pid, 0)` cannot always answer: EPERM means a process exists that we
 * may not signal, which is not evidence it is our daemon.
 */
export type ProcessLiveness = 'alive' | 'dead' | 'unknown';

/** Whether this starter removed the stale lock, or another starter beat it. */
export type StaleLockClaim = 'claimed' | 'lost';

export interface SingletonLockDependencies {
  readonly acquire: (
    lockTargetPath: string,
    onCompromised: (error: Error) => void,
  ) => Promise<ReleaseSingletonLock>;
  /** Wall-clock time this machine booted; a lock older than it is stale. */
  readonly bootTimeMs: () => number;
  readonly currentPid: number;
  readonly lockMtimeMs: (lockTargetPath: string) => Promise<number>;
  readonly now: () => number;
  readonly prepare: (stateDir: string, lockTargetPath: string) => Promise<void>;
  readonly processLiveness: (pid: number) => ProcessLiveness;
  readonly readPid: (lockTargetPath: string) => Promise<string>;
  readonly removeOwnPid: (lockTargetPath: string, pid: number) => Promise<void>;
  readonly removeStaleLock: (lockTargetPath: string, pid: number) => Promise<StaleLockClaim>;
  readonly socketAnswers: (socketPath: string) => Effect.Effect<boolean>;
  readonly writePid: (lockTargetPath: string, pid: number) => Promise<void>;
}

const processLiveness = (pid: number): ProcessLiveness => {
  try {
    process.kill(pid, 0);
    return 'alive';
  } catch (cause) {
    return hasErrorCode(cause, 'ESRCH') ? 'dead' : 'unknown';
  }
};

/**
 * Remove a stale proper-lockfile directory so that exactly one of several
 * concurrent starters succeeds. Two starters that both judged the lock stale
 * and both `rm -rf` it would let the second remove the first's fresh lock
 * and start two daemons; renaming the directory to a claimant-unique name
 * first is atomic, so the loser sees `ENOENT` and yields.
 */
export const claimStaleLock = async (
  lockTargetPath: string,
  pid: number,
): Promise<StaleLockClaim> => {
  const lockDir = `${lockTargetPath}.lock`;
  const claimDir = `${lockDir}.reclaim-${pid}`;
  // A leftover claim from an earlier crash of this pid would block the rename.
  await rm(claimDir, { recursive: true, force: true });
  try {
    await rename(lockDir, claimDir);
  } catch (cause) {
    if (hasErrorCode(cause, 'ENOENT')) {
      return 'lost';
    }
    throw cause;
  }
  await rm(claimDir, { recursive: true, force: true });
  return 'claimed';
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
  bootTimeMs: () => Date.now() - uptime() * 1_000,
  currentPid: process.pid,
  lockMtimeMs: async (lockTargetPath) => (await stat(`${lockTargetPath}.lock`)).mtimeMs,
  now: Date.now,
  prepare: async (stateDir, lockTargetPath) => {
    await mkdir(stateDir, { recursive: true });
    await writeFile(lockTargetPath, '', { flag: 'a' });
  },
  processLiveness,
  readPid: (lockTargetPath) => readFile(lockTargetPath, 'utf8'),
  removeOwnPid: async (lockTargetPath, pid) => {
    const recorded = await readFile(lockTargetPath, 'utf8').catch(() => '');
    if (recorded.trim() === String(pid)) {
      await rm(lockTargetPath, { force: true });
    }
  },
  removeStaleLock: claimStaleLock,
  socketAnswers: (socketPath) =>
    pingDaemon(socketPath, 500).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
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

type HeldLockVerdict =
  /** The lock directory vanished between the attempt and the inspection. */
  | { readonly kind: 'gone' }
  /** Recently refreshed and written since boot: its daemon may still be starting. */
  | { readonly kind: 'fresh' }
  /** Nobody can be refreshing it: aged past `staleMs`, or older than this boot. */
  | { readonly kind: 'stale' }
  /** Aged past `staleMs`, yet its recorded pid exists (or cannot be ruled out). */
  | { readonly kind: 'owner-present'; readonly liveness: ProcessLiveness; readonly pid: number };

const inspectHeldLock = (
  config: DaemonConfigShape,
  dependencies: SingletonLockDependencies,
): Effect.Effect<HeldLockVerdict, SingletonLockError> =>
  Effect.gen(function* () {
    const mtime = yield* Effect.result(
      Effect.tryPromise({
        try: () => dependencies.lockMtimeMs(config.lockTargetPath),
        catch: (cause) => new LockAttemptError({ cause }),
      }),
    );
    if (Result.isFailure(mtime)) {
      if (hasErrorCode(mtime.failure.cause, 'ENOENT')) {
        return { kind: 'gone' } as const;
      }
      return yield* singletonFailure(
        'unable to inspect the held singleton lock',
        mtime.failure.cause,
      );
    }
    const lockMtimeMs = mtime.success;
    // The state dir persists across reboots while pids do not: a lock written
    // before this boot cannot have a live owner, whatever its recorded pid now
    // names.
    if (lockMtimeMs < dependencies.bootTimeMs()) {
      return { kind: 'stale' } as const;
    }
    if (lockMtimeMs >= dependencies.now() - staleMs) {
      return { kind: 'fresh' } as const;
    }
    const recordedPid = yield* Effect.tryPromise({
      try: () => dependencies.readPid(config.lockTargetPath),
      catch: (cause) => singletonFailure('unable to read the singleton owner pid', cause),
    }).pipe(Effect.map(parsePid));
    if (recordedPid === null) {
      return { kind: 'stale' } as const;
    }
    const liveness = dependencies.processLiveness(recordedPid);
    switch (liveness) {
      case 'dead':
        return { kind: 'stale' } as const;
      case 'alive':
      case 'unknown':
        return { kind: 'owner-present', liveness, pid: recordedPid } as const;
      default: {
        const exhaustive: never = liveness;
        return yield* Effect.die(new Error(`Unhandled liveness: ${String(exhaustive)}`));
      }
    }
  });

/**
 * Take the lock, recovering from a stale one. A held lock is re-checked
 * (ping, mtime, owner liveness) about once a second for `staleMs` plus a
 * margin rather than judged once: an uncleanly killed daemon's lock still
 * looks fresh for up to `staleMs`, and a starter that gave up on it would
 * leave the daemon down until someone removed the lock by hand.
 */
const acquireWithRecovery = (
  config: DaemonConfigShape,
  dependencies: SingletonLockDependencies,
  onCompromised: (error: Error) => void,
): Effect.Effect<ReleaseSingletonLock, DaemonAlreadyRunningError | SingletonLockError> =>
  Effect.gen(function* () {
    const acquireOnce = Effect.tryPromise({
      try: () => dependencies.acquire(config.lockTargetPath, onCompromised),
      catch: (cause) => new LockAttemptError({ cause }),
    });
    const deadlineMs = dependencies.now() + staleMs + recoveryMarginMs;
    let attempts = 0;
    while (true) {
      attempts += 1;
      if (attempts > maxAcquireAttempts) {
        // Only reachable if the lock keeps changing hands between every
        // attempt and inspection; the timed path below is the normal bound.
        return yield* singletonFailure(
          `singleton lock could not be acquired after ${maxAcquireAttempts} attempts`,
        );
      }
      const attempt = yield* Effect.result(acquireOnce);
      if (Result.isSuccess(attempt)) {
        return attempt.success;
      }
      const lockCause = attempt.failure.cause;
      if (!isLockedError(lockCause)) {
        return yield* new SingletonLockError({ cause: lockCause });
      }
      if (yield* dependencies.socketAnswers(config.socketPath)) {
        return yield* new DaemonAlreadyRunningError({ lockTargetPath: config.lockTargetPath });
      }
      const verdict = yield* inspectHeldLock(config, dependencies);
      switch (verdict.kind) {
        case 'gone':
          // Released between the attempt and the inspection: try again now.
          break;
        case 'stale':
          // 'lost' means a competing starter claimed it first; the next
          // attempt then finds that starter's fresh lock and waits on it.
          yield* Effect.tryPromise({
            try: () =>
              dependencies.removeStaleLock(config.lockTargetPath, dependencies.currentPid),
            catch: (cause) =>
              singletonFailure('unable to remove the stale singleton lock', cause),
          });
          break;
        case 'owner-present':
          return yield* singletonFailure(
            verdict.liveness === 'alive'
              ? `singleton lock owner pid ${verdict.pid} is alive but its socket is not answering`
              : `singleton lock owner pid ${verdict.pid} cannot be signalled and its socket is not answering`,
          );
        case 'fresh':
          if (dependencies.now() >= deadlineMs) {
            return yield* singletonFailure(
              'singleton lock is held but its daemon is not yet answering',
            );
          }
          yield* Effect.sleep(recoveryPollMs);
          break;
        default: {
          const exhaustive: never = verdict;
          return yield* Effect.die(new Error(`Unhandled lock verdict: ${String(exhaustive)}`));
        }
      }
    }
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
  // The proper-lockfile callback runs outside Effect, so this watcher bridges
  // its deferred signal back into the daemon fiber.
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

  const release = yield* acquireWithRecovery(config, dependencies, compromise.onCompromised);

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
    Effect.sync(() => armSharedJobserver({ mode: config.jobserverMode, stateDir: config.stateDir })),
    () => Effect.sync(() => releaseSharedJobserver()),
  );
});
