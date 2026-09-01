import { mkdir, writeFile } from 'node:fs/promises';

import * as Data from 'effect/Data';
import * as Effect from 'effect/Effect';
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

const isLockedError = (cause: unknown): boolean =>
  typeof cause === 'object' &&
  cause !== null &&
  'code' in cause &&
  (cause as { readonly code?: unknown }).code === 'ELOCKED';

/**
 * Losing the lock means another daemon may already be binding our socket path and
 * writing our ledger, so a hard exit is safer than continuing as a second daemon.
 */
const onCompromised = (error: Error): void => {
  process.stderr.write(`cargo-conductor: singleton lock compromised: ${error.message}\n`);
  process.exit(1);
};

export const acquireSingletonLock: Effect.Effect<
  void,
  DaemonAlreadyRunningError | SingletonLockError,
  DaemonConfig | Scope.Scope
> = Effect.gen(function* () {
  const config = yield* DaemonConfig;

  yield* Effect.tryPromise({
    try: async () => {
      await mkdir(config.stateDir, { recursive: true });
      await writeFile(config.lockTargetPath, '', { flag: 'a' });
    },
    catch: (cause) => new SingletonLockError({ cause }),
  });

  yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () => lock(config.lockTargetPath, { onCompromised, stale: staleMs }),
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
