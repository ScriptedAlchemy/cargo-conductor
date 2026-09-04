import {
  existsSync,
  fstatSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'effect-rstest';
import * as Effect from 'effect/Effect';
import * as Schedule from 'effect/Schedule';

import type { ChildProcess, SpawnOptions } from 'node:child_process';

import { resolveDaemonConfig, type DaemonConfigShape } from '../src/daemon/config.js';
import {
  daemonIsAbsent,
  daemonSpawnEnv,
  ensureDaemonRunning,
  spawnDetachedDaemon,
} from '../src/client/ensure-daemon.js';
import { pingDaemon } from '../src/daemon/control.js';
import { runDaemon } from '../src/daemon/main.js';
import { passthroughSpoolFileName } from '../src/daemon/protocol.js';
import { scopedEnv, scopedTempDir } from './harness.js';

const configAt = (stateDir: string): DaemonConfigShape => ({
  stateDir,
  socketPath: join(stateDir, 'daemon.sock'),
  databasePath: join(stateDir, 'ledger.db'),
  lockTargetPath: join(stateDir, 'daemon.pid'),
  logPath: join(stateDir, 'daemon.log'),
  maxConcurrent: 1,
  outputTailBytes: 1024,
  ticketLogDir: join(stateDir, 'tickets'),
  ticketLogMaxBytes: 1024,
  replayBufferBytes: 1024,
  kacheIndexPath: '',
  jobsGrant: 1,
  batchEnabled: false,
  batchWindowMs: 0,
  loadThresholdPerCore: null,
  loadMinConcurrent: 2,
  cpuStallThreshold: null,
  memPressureSoftThreshold: null,
  memPressureHardThreshold: null,
  memAvailableMinBytes: null,
  memPressureLevelThreshold: null,
  heavyMemAvailableBytes: null,
  heavyMaxConcurrent: 1,
  ledgerRetentionDays: 0,
  ledgerMaxRows: 0,
  jobserverMode: 'auto',
  stallEstimateFactor: 3,
  stallIdleMs: null,
  stallAutoKill: true,
});

describe('spawnDetachedDaemon', () => {
  it.live('closes the log descriptor and returns a typed failure when spawn throws', () =>
    Effect.gen(function* () {
      const stateDir = yield* scopedTempDir('cc-ensure-daemon-');
      let logFd = -1;
      const error = yield* Effect.flip(
        spawnDetachedDaemon(configAt(stateDir), '/missing/entry.js', {
          spawnProcess: (_command, _args, options) => {
            const stdio = options.stdio;
            if (!Array.isArray(stdio) || typeof stdio[1] !== 'number') {
              throw new Error('test expected the log descriptor in stdio');
            }
            logFd = stdio[1];
            throw new Error('spawn exploded');
          },
        }),
      );

      expect(error._tag).toBe('SpawnDaemonError');
      expect(error.cause).toBeInstanceOf(Error);
      expect(() => fstatSync(logFd)).toThrow();
    }));

  it.live('spawns the daemon with a curated environment and the state dir as cwd', () =>
    Effect.gen(function* () {
      const root = yield* scopedTempDir('cc-spawn-env-');
      // Not pre-created: the spawn must build it before using it as cwd.
      const stateDir = join(root, 'state');
      // The first client's build knobs must not become the base of every
      // other session's cargo for the daemon's whole life (#55).
      yield* scopedEnv({
        CARGO_BUILD_TARGET: 'x86_64-unknown-linux-musl',
        CARGO_HAULER_MAX_CONCURRENT: '3',
        CARGO_HOME: '/opt/cargo-home',
        CARGO_TARGET_DIR: '/tmp/somebody-elses-target',
        CC: 'clang',
        MAKEFLAGS: '-j --jobserver-auth=3,4',
        RUSTC_WRAPPER: 'sccache',
        RUSTFLAGS: '-C target-cpu=native',
        RUSTUP_TOOLCHAIN: 'nightly',
        SCCACHE_DIR: '/tmp/sccache',
        XDG_CACHE_HOME: '/tmp/xdg-cache',
        https_proxy: 'http://proxy:3128',
      });
      let seen: SpawnOptions | undefined;
      yield* spawnDetachedDaemon(configAt(stateDir), '/entry.js', {
        spawnProcess: (_command, _args, options) => {
          seen = options;
          return { unref: () => undefined } as unknown as ChildProcess;
        },
      });

      expect(seen?.cwd).toBe(stateDir);
      expect(existsSync(stateDir)).toBe(true);
      const env = seen?.env ?? {};
      expect(env.CARGO_HAULER_STATE_DIR).toBe(stateDir);
      expect(env.CARGO_HAULER_MAX_CONCURRENT).toBe('3');
      expect(env.PATH).toBe(process.env.PATH);
      expect(env.HOME).toBe(process.env.HOME);
      expect(env.CARGO_HOME).toBe('/opt/cargo-home');
      expect(env.XDG_CACHE_HOME).toBe('/tmp/xdg-cache');
      expect(env.https_proxy).toBe('http://proxy:3128');
      for (const forbidden of [
        'CARGO_BUILD_TARGET',
        'CARGO_TARGET_DIR',
        'CC',
        'MAKEFLAGS',
        'RUSTC_WRAPPER',
        'RUSTFLAGS',
        'RUSTUP_TOOLCHAIN',
        'SCCACHE_DIR',
      ]) {
        expect(env).not.toHaveProperty(forbidden);
      }
    }));
});

describe('daemonSpawnEnv', () => {
  it('keeps only the daemon’s own settings plus locale, paths, and network knobs', () => {
    const env = daemonSpawnEnv(
      {
        CARGO_CONDUCTOR_KILL_GRACE_MS: '1',
        CARGO_HAULER_STATE_DIR: '/elsewhere',
        CARGO_TARGET_DIR: '/t',
        HOME: '/home/a',
        LANG: 'C.UTF-8',
        LC_ALL: 'C',
        LOGNAME: 'a',
        NO_PROXY: 'localhost',
        PATH: '/bin',
        RUSTFLAGS: '-C opt-level=3',
        RUSTUP_HOME: '/rustup',
        SHELL: '/bin/zsh',
        SSL_CERT_FILE: '/ca.pem',
        TMPDIR: '/tmp/x',
        USER: 'a',
        undefinedValue: undefined,
      },
      '/state',
    );
    expect(env).toEqual({
      CARGO_CONDUCTOR_KILL_GRACE_MS: '1',
      CARGO_HAULER_STATE_DIR: '/state',
      HOME: '/home/a',
      LANG: 'C.UTF-8',
      LC_ALL: 'C',
      LOGNAME: 'a',
      NO_PROXY: 'localhost',
      PATH: '/bin',
      RUSTUP_HOME: '/rustup',
      SHELL: '/bin/zsh',
      SSL_CERT_FILE: '/ca.pem',
      TMPDIR: '/tmp/x',
      USER: 'a',
    });
  });
});

describe('ensureDaemonRunning', () => {
  it.effect('refuses to spawn when a live daemon already answers the socket', () =>
    Effect.gen(function* () {
      const expected = {
        type: 'pong' as const,
        id: 'existing',
        pid: 777,
        startedAtMs: 1,
        version: 'test',
      };
      let spawned = 0;
      const actual = yield* ensureDaemonRunning(configAt('/tmp/cargo-hauler-existing-daemon'), {
        pingDaemon: () => Effect.succeed(expected),
        spawnDetachedDaemon: () =>
          Effect.sync(() => {
            spawned += 1;
          }),
        waitForDaemon: () => Effect.die(new Error('wait should not run')),
      });

      expect(actual).toBe(expected);
      expect(spawned).toBe(0);
    }));
});

describe('daemon start without a machine-specific mount', () => {
  it.live('starts in a fresh temp state dir that does not exist yet (no /fast anywhere)', () =>
    Effect.gen(function* () {
      const root = yield* scopedTempDir('cc-portable-state-');
      // Deliberately not pre-created: the daemon must build its own state dir.
      const stateDir = join(root, 'nested', 'state');
      const config = resolveDaemonConfig({
        CARGO_HAULER_STATE_DIR: stateDir,
        CARGO_HAULER_KACHE_INDEX: '',
      });
      // The daemon lives in an inner scope: the assertions after it check
      // what shutdown leaves behind.
      const pong = yield* Effect.scoped(
        Effect.gen(function* () {
          yield* Effect.forkScoped(runDaemon(config));
          // A cold in-process daemon on a slow CI runner (macOS) can take
          // longer than the 5 s default to open its socket.
          const reply = yield* pingDaemon(config.socketPath, 500).pipe(
            Effect.retry(Schedule.spaced('50 millis').pipe(Schedule.upTo({ times: 400 }))),
          );
          // Assert while the daemon is still up; scope close removes it.
          expect(existsSync(config.socketPath)).toBe(true);
          expect(readFileSync(config.lockTargetPath, 'utf8')).toBe(`${process.pid}\n`);
          return reply;
        }),
      );
      expect(pong.type).toBe('pong');
      expect(existsSync(config.lockTargetPath)).toBe(false);
    }), 30_000);

  it.live('rewrites a stale pid record while holding the lock and removes it on shutdown', () =>
    Effect.gen(function* () {
      const root = yield* scopedTempDir('cc-stale-pid-');
      const config = resolveDaemonConfig({
        CARGO_HAULER_STATE_DIR: join(root, 'state'),
        CARGO_HAULER_KACHE_INDEX: '',
      });
      mkdirSync(config.stateDir, { recursive: true });
      writeFileSync(config.lockTargetPath, '4184464\n');
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* Effect.forkScoped(runDaemon(config));
          yield* pingDaemon(config.socketPath, 500).pipe(
            Effect.retry(Schedule.spaced('50 millis').pipe(Schedule.upTo({ times: 100 }))),
          );
          expect(readFileSync(config.lockTargetPath, 'utf8')).toBe(`${process.pid}\n`);
        }),
      );
      expect(existsSync(config.lockTargetPath)).toBe(false);
      expect(existsSync(config.socketPath)).toBe(false);
    }));

  it.live('a losing instance neither drains the passthrough spool nor touches the ledger', () =>
    Effect.gen(function* () {
      const root = yield* scopedTempDir('cc-losing-instance-');
      const config = resolveDaemonConfig({
        CARGO_HAULER_STATE_DIR: join(root, 'state'),
        CARGO_HAULER_KACHE_INDEX: '',
      });
      const spoolPath = join(config.stateDir, passthroughSpoolFileName);
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* Effect.forkScoped(runDaemon(config));
          yield* pingDaemon(config.socketPath, 500).pipe(
            Effect.retry(Schedule.spaced('50 millis').pipe(Schedule.upTo({ times: 400 }))),
          );
          // Spooled after the live daemon's own startup drain, so only a
          // second daemon building its Broker layer could move it.
          writeFileSync(spoolPath, '');
          const ledgerBefore = statSync(config.databasePath);

          const outcome = yield* runDaemon(config);

          expect(outcome).toBe('already-running');
          expect(existsSync(spoolPath)).toBe(true);
          expect(existsSync(`${spoolPath}.drain`)).toBe(false);
          expect(statSync(config.databasePath).mtimeMs).toBe(ledgerBefore.mtimeMs);
        }),
      );
    }), 30_000);
});

describe('daemonIsAbsent', () => {
  it.live('classifies a real dead-socket ping failure as absent (v4 nests the code under reason)', () =>
    Effect.gen(function* () {
      const stateDir = yield* scopedTempDir('cc-absent-');
      const error = yield* Effect.flip(pingDaemon(join(stateDir, 'missing.sock'), 300));
      expect(error._tag).toBe('DaemonUnreachable');
      // The regression: v4 Socket errors wrap the syscall error under
      // `.reason`; a walk that only follows `.cause` never finds the code,
      // classifies the daemon as non-absent, and clients never spawn it.
      expect(daemonIsAbsent(error.cause)).toBe(true);
    }));
});
