import { mkdtemp, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from '@rstest/core';
import * as Effect from 'effect/Effect';

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
  it('fails when the bound socket path is unlinked', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'cargo-hauler-socket-owner-'));
    const socketPath = join(stateDir, 'daemon.sock');
    try {
      await writeFile(socketPath, 'bound socket stand-in');
      const identity = await readSocketIdentity(socketPath);
      const lost = Effect.runPromise(
        Effect.flip(monitorSocketOwnership(socketPath, identity, 5)),
      );

      await new Promise((resolve) => setTimeout(resolve, 15));
      await unlink(socketPath);

      const error = await lost;
      expect(error._tag).toBe('SocketOwnershipLost');
      expect(error.socketPath).toBe(socketPath);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

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
