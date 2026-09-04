import { existsSync } from 'node:fs';
import { mkdtemp, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'effect-rstest';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Fiber from 'effect/Fiber';
import * as Schedule from 'effect/Schedule';
import * as Scope from 'effect/Scope';

import { resolveDaemonConfig } from '../src/daemon/config.js';
import { pingDaemon } from '../src/daemon/control.js';
import {
  makeSignalShutdownController,
  runForegroundDaemon,
  stopDaemon,
} from '../src/daemon/lifecycle.js';
import { bindDaemonSocket, socketListenPath } from '../src/daemon/main.js';
import {
  monitorSocketOwnership,
  readSocketIdentity,
  removeSocketIfOwned,
} from '../src/daemon/socket-ownership.js';
import { scopedTempDir } from './harness.js';

const connectOnce = (socketPath: string): Effect.Effect<void, Error> =>
  Effect.callback<void, Error>((resume) => {
    const client = connect(socketPath);
    client.once('connect', () => {
      client.destroy();
      resume(Effect.void);
    });
    client.once('error', (error) => resume(Effect.fail(error)));
  });

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

  it.live('keeps its signal handlers installed for repeats until teardown completes', () =>
    Effect.gen(function* () {
      const root = yield* scopedTempDir('cargo-hauler-signal-');
      const config = resolveDaemonConfig({
        CARGO_HAULER_STATE_DIR: join(root, 'state'),
        CARGO_HAULER_KACHE_INDEX: '',
      });
      const before = new Set(process.rawListeners('SIGINT'));
      const running = runForegroundDaemon(config);
      yield* pingDaemon(config.socketPath, 500).pipe(
        Effect.retry(Schedule.spaced('50 millis').pipe(Schedule.upTo({ times: 400 }))),
      );

      const added = process.rawListeners('SIGINT').filter((listener) => !before.has(listener));
      expect(added).toHaveLength(1);
      // `process.once` hands back a wrapper carrying `.listener` and removes
      // itself on the first signal, so a second Ctrl-C would reach Node's
      // default handler and skip every finalizer (lock and socket left
      // behind). The daemon must register with `process.on` and let its
      // `signaled` guard swallow repeats.
      expect(Object.hasOwn(added[0] as object, 'listener')).toBe(false);

      yield* stopDaemon(config);
      const outcome = yield* Effect.promise(() => running);
      expect(outcome.message).toBe('completed');
      expect(process.rawListeners('SIGINT').filter((listener) => !before.has(listener))).toEqual(
        [],
      );
    }), 30_000);
});

describe('socket listen path', () => {
  it('is never longer than the canonical socket path so it fits sun_path wherever the canonical one does', () => {
    const canonical = `/private/var/folders/d8/${'x'.repeat(30)}/T/cargo-hauler-socket-rename-cjiTJc/daemon.sock`;
    const listen = socketListenPath(canonical, 5226);
    expect(dirname(listen)).toBe(dirname(canonical));
    expect(Buffer.byteLength(listen)).toBeLessThanOrEqual(Buffer.byteLength(canonical));
    expect(socketListenPath(canonical, 9_999_999).length).toBeLessThanOrEqual(canonical.length);
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

  it.live('closing a superseded server leaves the replacement daemon bound and reachable', () =>
    Effect.gen(function* () {
      const stateDir = yield* scopedTempDir('cargo-hauler-socket-rename-');
      const socketPath = join(stateDir, 'daemon.sock');
      const replacementScope = yield* Scope.make();
      yield* Effect.addFinalizer(() => Scope.close(replacementScope, Exit.void));

      const replacement = yield* Effect.scoped(
        Effect.gen(function* () {
          const superseded = yield* bindDaemonSocket(socketPath);
          expect(superseded.identity).not.toBeNull();
          // A replacement daemon judged us dead: it removed the path and
          // bound its own socket there, exactly what monitorSocketOwnership
          // exists to detect. Our teardown must not take it down with us.
          yield* Effect.promise(() => rm(socketPath, { force: true }));
          return yield* bindDaemonSocket(socketPath).pipe(
            Effect.provideService(Scope.Scope, replacementScope),
          );
        }),
      );

      expect(existsSync(socketPath)).toBe(true);
      expect(yield* Effect.promise(() => readSocketIdentity(socketPath))).toEqual(
        replacement.identity,
      );
      yield* connectOnce(socketPath);
    }));
});
