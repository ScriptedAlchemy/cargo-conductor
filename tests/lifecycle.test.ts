import { mkdtemp, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'effect-rstest';
import * as Effect from 'effect/Effect';
import * as Fiber from 'effect/Fiber';

import { makeSignalShutdownController } from '../src/daemon/lifecycle.js';
import {
  monitorSocketOwnership,
  readSocketIdentity,
  removeSocketIfOwned,
} from '../src/daemon/socket-ownership.js';

describe('signal shutdown lifecycle', () => {
  it('keeps teardown alive and forces SIGTERM exit after the grace window', () => {
    let interrupted = 0;
    let exitCode: number | undefined;
    let forcedCode: number | undefined;
    let delayMs: number | undefined;
    let fallback: (() => void) | undefined;
    let keepAliveCancelled = 0;
    let fallbackCancelled = 0;
    const controller = makeSignalShutdownController(
      () => {
        interrupted += 1;
      },
      {
        forceExit: (code) => {
          forcedCode = code;
        },
        keepAlive: () => () => {
          keepAliveCancelled += 1;
        },
        scheduleForceExit: (callback, delay) => {
          fallback = callback;
          delayMs = delay;
          return () => {
            fallbackCancelled += 1;
          };
        },
        setExitCode: (code) => {
          exitCode = code;
        },
      },
    );

    controller.onSignal('SIGTERM');
    expect(interrupted).toBe(1);
    expect(exitCode).toBe(143);
    expect(delayMs).toBe(5_000);
    expect(forcedCode).toBeUndefined();

    fallback?.();
    expect(forcedCode).toBe(143);

    controller.teardownComplete();
    expect(keepAliveCancelled).toBe(1);
    expect(fallbackCancelled).toBe(1);
  });

  it('uses 130 for SIGINT and handles repeated signals once', () => {
    const exitCodes: number[] = [];
    let interrupted = 0;
    const controller = makeSignalShutdownController(
      () => {
        interrupted += 1;
      },
      {
        forceExit: () => undefined,
        keepAlive: () => () => undefined,
        scheduleForceExit: () => () => undefined,
        setExitCode: (code) => {
          exitCodes.push(code);
        },
      },
    );

    controller.onSignal('SIGINT');
    controller.onSignal('SIGTERM');

    expect(interrupted).toBe(1);
    expect(exitCodes).toEqual([130]);
  });
});

describe('socket ownership lifecycle', () => {
  it.live('fails when the bound socket path is unlinked', () =>
    Effect.gen(function* () {
      const stateDir = yield* Effect.acquireRelease(
        Effect.promise(() => mkdtemp(join(tmpdir(), 'cargo-hauler-socket-owner-'))),
        (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
      );
      const socketPath = join(stateDir, 'daemon.sock');
      yield* Effect.promise(() => writeFile(socketPath, 'bound socket stand-in'));
      const identity = yield* Effect.promise(() => readSocketIdentity(socketPath));
      const lost = yield* Effect.forkChild(
        Effect.flip(monitorSocketOwnership(socketPath, identity, 5)),
      );

      yield* Effect.sleep('15 millis');
      yield* Effect.promise(() => unlink(socketPath));

      const error = yield* Fiber.join(lost);
      expect(error._tag).toBe('SocketOwnershipLost');
      expect(error.socketPath).toBe(socketPath);
    }));

  it('does not unlink a replacement socket during teardown', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'cargo-hauler-socket-cleanup-'));
    const socketPath = join(stateDir, 'daemon.sock');
    const replacementPath = join(stateDir, 'replacement.sock');
    try {
      await writeFile(socketPath, 'original');
      await writeFile(replacementPath, 'replacement');
      const identity = await readSocketIdentity(socketPath);
      await unlink(socketPath);
      await rename(replacementPath, socketPath);

      await removeSocketIfOwned(socketPath, identity);

      expect((await stat(socketPath)).isFile()).toBe(true);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});
