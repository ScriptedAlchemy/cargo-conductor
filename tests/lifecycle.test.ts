import { existsSync } from 'node:fs';
import { mkdtemp, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { version } from 'agent-bundle/meta';
import { describe, expect, it } from 'effect-rstest';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Fiber from 'effect/Fiber';
import * as Schedule from 'effect/Schedule';
import * as Scope from 'effect/Scope';

import type { EnsureDaemonDependencies } from '../src/client/ensure-daemon.js';
import { resolveDaemonConfig } from '../src/daemon/config.js';
import type { DaemonConfigShape } from '../src/daemon/config.js';
import { pingDaemon } from '../src/daemon/control.js';
import {
  daemonExitCode,
  makeSignalShutdownController,
  parseDaemonSubcommand,
  restartDaemon,
  runForegroundDaemon,
  startDaemon,
  stopDaemon,
  type DaemonControlResult,
  type RestartDaemonDependencies,
} from '../src/daemon/lifecycle.js';
import { bindDaemonSocket, runDaemon, socketListenPath } from '../src/daemon/main.js';
import { daemonIdentity, type DaemonIdentity } from '../src/daemon/shutdown.js';
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

describe('daemon start under the one-version rule', () => {
  const config = resolveDaemonConfig({ CARGO_HAULER_STATE_DIR: '/tmp/cargo-hauler-start-unit' });

  it.live('reports a daemon of another version that outlived the grace as running, not replaced', () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const dependencies: EnsureDaemonDependencies = {
        exitGraceMs: 40,
        pingDaemon: () =>
          Effect.succeed({ id: 'old', pid: 41, startedAtMs: 1, type: 'pong', version: '0.4.1' }),
        pollMs: 5,
        processAlive: () => true,
        requestShutdown: () =>
          Effect.sync(() => {
            calls.push('shutdown');
            return 'acknowledged' as const;
          }),
        spawnDetachedDaemon: () => Effect.die(new Error('spawn should not run')),
        waitForDaemon: () => Effect.die(new Error('wait should not run')),
      };
      const result = yield* startDaemon(config, dependencies);

      expect(calls).toEqual(['shutdown']);
      expect(result).toMatchObject({
        operation: 'daemon',
        pid: 41,
        previousPid: 41,
        report: null,
        running: true,
        subcommand: 'start',
      });
      expect(result.message).toBe(
        'cargo-hauler daemon pid 41 (0.4.1) is still running 40ms after the shutdown request; not restarted — retry once it has exited, or stop it with `hauler daemon stop`',
      );
      // A daemon is running, but not this build's: the same verdict as a
      // restart that could not replace it.
      expect(daemonExitCode(result)).toBe(1);
    }));

  it.effect('reports a daemon of this build as started, with no previousPid, and exits 0', () =>
    Effect.gen(function* () {
      const result = yield* startDaemon(config, {
        exitGraceMs: 40,
        pingDaemon: () => Effect.succeed({ id: 'same', pid: 42, startedAtMs: 2, type: 'pong', version }),
        pollMs: 5,
        processAlive: () => true,
        requestShutdown: () => Effect.die(new Error('shutdown should not run')),
        spawnDetachedDaemon: () => Effect.die(new Error('spawn should not run')),
        waitForDaemon: () => Effect.die(new Error('wait should not run')),
      });

      expect(result).toMatchObject({ pid: 42, running: true, subcommand: 'start' });
      expect(result.previousPid).toBeUndefined();
      expect(result.message).toBe('cargo-hauler daemon started (pid 42)');
      expect(daemonExitCode(result)).toBe(0);
    }));
});

describe('daemon restart', () => {
  const config = resolveDaemonConfig({ CARGO_HAULER_STATE_DIR: '/tmp/cargo-hauler-restart-unit' });
  const controlResult = (
    subcommand: 'start' | 'stop',
    fields: Partial<DaemonControlResult> = {},
  ): DaemonControlResult => ({
    message: subcommand === 'start' ? 'cargo-hauler daemon started (pid 42)' : 'cargo-hauler daemon stopped',
    operation: 'daemon',
    pid: subcommand === 'start' ? 42 : null,
    report: null,
    running: subcommand === 'start',
    socketPath: config.socketPath,
    subcommand,
    ...fields,
  });
  const old: DaemonIdentity = { pid: 41, startedAtMs: 1, version: '0.4.1' };
  const fresh: DaemonIdentity = { pid: 42, startedAtMs: 2, version: '0.4.4' };

  /** Fakes: the old daemon (pid 41) answers until `stop`, exits shortly after, and `start` brings up pid 42. */
  const fakes = (overrides: Partial<RestartDaemonDependencies> = {}) => {
    const calls: string[] = [];
    let alive = true;
    let stopped = false;
    const dependencies: RestartDaemonDependencies = {
      exitGraceMs: 500,
      identify: () => Effect.sync(() => (stopped ? (alive ? old : fresh) : old)),
      pollMs: 5,
      processAlive: () => alive,
      start: () =>
        Effect.sync(() => {
          calls.push('start');
          return controlResult('start');
        }),
      stop: () =>
        Effect.sync(() => {
          calls.push('stop');
          stopped = true;
          setTimeout(() => {
            alive = false;
          }, 30);
          return controlResult('stop');
        }),
      ...overrides,
    };
    return { calls, dependencies };
  };

  it.live('stops the running daemon, waits for its pid to exit, starts a new one, and names both', () =>
    Effect.gen(function* () {
      const { calls, dependencies } = fakes();
      const result = yield* restartDaemon(config, dependencies);
      expect(calls).toEqual(['stop', 'start']);
      expect(result).toMatchObject({
        operation: 'daemon',
        pid: 42,
        previousPid: 41,
        running: true,
        subcommand: 'restart',
      });
      expect(result.message).toBe('cargo-hauler daemon restarted: pid 41 (0.4.1) → pid 42 (0.4.4)');
      expect(daemonExitCode(result)).toBe(0);
    }));

  it.live('starts the daemon when none was running and says so', () =>
    Effect.gen(function* () {
      const { calls, dependencies } = fakes({ identify: () => Effect.succeed(null) });
      const result = yield* restartDaemon(config, {
        ...dependencies,
        // Nobody answered before; the new daemon answers after `start`.
        identify: () => Effect.sync(() => (calls.includes('start') ? fresh : null)),
      });
      expect(calls).toEqual(['start']);
      expect(result).toMatchObject({ pid: 42, previousPid: null, running: true, subcommand: 'restart' });
      expect(result.message).toBe('cargo-hauler daemon was not running; started pid 42 (0.4.4)');
      expect(daemonExitCode(result)).toBe(0);
    }));

  it.live('does not start a second daemon while the old pid is still alive after the grace', () =>
    Effect.gen(function* () {
      const { calls, dependencies } = fakes({ exitGraceMs: 40, processAlive: () => true });
      const result = yield* restartDaemon(config, dependencies);
      expect(calls).toEqual(['stop']);
      expect(result).toMatchObject({ pid: 41, previousPid: 41, running: true, subcommand: 'restart' });
      expect(result.message).toContain('pid 41 (0.4.1) is still running 40ms after the shutdown request');
      expect(result.message).toContain('not restarted');
      expect(daemonExitCode(result)).toBe(1);
    }));

  it('is a daemon subcommand', () => {
    expect(parseDaemonSubcommand(['restart'])).toBe('restart');
    expect(() => parseDaemonSubcommand(['reload'])).toThrow('run, start, stop, status, restart');
  });

  it.live('restarts a live daemon: the old one stops before the new one is started', () =>
    Effect.gen(function* () {
      const root = yield* scopedTempDir('cargo-hauler-restart-');
      const liveConfig: DaemonConfigShape = resolveDaemonConfig({
        CARGO_HAULER_STATE_DIR: join(root, 'state'),
        CARGO_HAULER_KACHE_INDEX: '',
      });
      const scope = yield* Scope.make();
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
      const startInProcess = (): Effect.Effect<DaemonControlResult> =>
        Effect.gen(function* () {
          yield* Effect.forkIn(runDaemon(liveConfig), scope);
          const pong = yield* pingDaemon(liveConfig.socketPath, 500).pipe(
            Effect.retry(Schedule.spaced('50 millis').pipe(Schedule.upTo({ times: 400 }))),
          );
          const started: DaemonControlResult = {
            message: `cargo-hauler daemon started (pid ${pong.pid})`,
            operation: 'daemon',
            pid: pong.pid,
            report: null,
            running: true,
            socketPath: liveConfig.socketPath,
            subcommand: 'start',
          };
          return started;
        }).pipe(Effect.orDie);
      const first = yield* startInProcess();
      const startedAt = (yield* pingDaemon(liveConfig.socketPath, 500)).startedAtMs;
      yield* Effect.sleep('5 millis');

      let sawSocketGone = false;
      const result = yield* restartDaemon(liveConfig, {
        exitGraceMs: 5_000,
        identify: daemonIdentity,
        pollMs: 10,
        // Both daemons live in this test process, so "the process exited" is
        // "its socket is gone" — which the daemon removes on shutdown.
        processAlive: () => {
          const alive = existsSync(liveConfig.socketPath);
          sawSocketGone ||= !alive;
          return alive;
        },
        start: startInProcess,
        stop: stopDaemon,
      });
      expect(sawSocketGone).toBe(true);
      expect(result.running).toBe(true);
      expect(result.previousPid).toBe(first.pid);
      expect(result.message).toContain('restarted');
      const after = yield* pingDaemon(liveConfig.socketPath, 500);
      expect(after.startedAtMs).toBeGreaterThan(startedAt);
      yield* stopDaemon(liveConfig);
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
