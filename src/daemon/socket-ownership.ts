import { rm, stat } from 'node:fs/promises';

import * as Data from 'effect/Data';
import * as Effect from 'effect/Effect';

export interface SocketIdentity {
  readonly device: number;
  readonly inode: number;
}

export class SocketOwnershipLostError extends Data.TaggedError('SocketOwnershipLost')<{
  readonly cause?: unknown;
  readonly socketPath: string;
}> {}

export const readSocketIdentity = async (socketPath: string): Promise<SocketIdentity> => {
  const metadata = await stat(socketPath);
  return {
    device: metadata.dev,
    inode: metadata.ino,
  };
};

const identitiesMatch = (left: SocketIdentity, right: SocketIdentity): boolean =>
  left.device === right.device && left.inode === right.inode;

export const removeSocketIfOwned = async (
  socketPath: string,
  expected: SocketIdentity,
): Promise<void> => {
  const current = await readSocketIdentity(socketPath).catch(() => null);
  if (current !== null && identitiesMatch(current, expected)) {
    await rm(socketPath, { force: true });
  }
};

/**
 * A Unix server remains usable after its pathname is unlinked, which can
 * leave an invisible daemon serving no new clients. Comparing the bound
 * socket's inode to the pathname once per second makes that ownership loss
 * fatal, while inode-guarded teardown cannot unlink a replacement daemon.
 */
export const monitorSocketOwnership = (
  socketPath: string,
  expected: SocketIdentity,
  intervalMs = 1_000,
): Effect.Effect<never, SocketOwnershipLostError> =>
  Effect.forever(
    Effect.sleep(intervalMs).pipe(
      Effect.andThen(
        Effect.tryPromise({
          try: () => readSocketIdentity(socketPath),
          catch: (cause) => new SocketOwnershipLostError({ cause, socketPath }),
        }),
      ),
      Effect.flatMap((current) =>
        identitiesMatch(current, expected)
          ? Effect.void
          : Effect.fail(new SocketOwnershipLostError({ socketPath })),
      ),
    ),
  );
