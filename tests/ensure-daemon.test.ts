import {
  existsSync,
  fstatSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'effect-rstest';
import * as Effect from 'effect/Effect';
import * as Schedule from 'effect/Schedule';

import { resolveDaemonConfig, type DaemonConfigShape } from '../src/daemon/config.js';
import {
  daemonIsAbsent,
  ensureDaemonRunning,
  spawnDetachedDaemon,
} from '../src/client/ensure-daemon.js';
import { pingDaemon } from '../src/daemon/control.js';
import { runDaemon } from '../src/daemon/main.js';
import { scopedTempDir } from './harness.js';

const configAt = (stateDir: string): DaemonConfigShape => ({
  stateDir,
  socketPath: join(stateDir, 'daemon.sock'),
  databasePath: join(stateDir, 'ledger.db'),
  lockTargetPath: join(stateDir, 'daemon.pid'),
  logPath: join(stateDir, 'daemon.log'),
  maxConcurrent: 1,
  outputTailBytes: 1024,
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
          const reply = yield* pingDaemon(config.socketPath, 500).pipe(
            Effect.retry(Schedule.spaced('50 millis').pipe(Schedule.upTo({ times: 100 }))),
          );
          // Assert while the daemon is still up; scope close removes it.
          expect(existsSync(config.socketPath)).toBe(true);
          expect(readFileSync(config.lockTargetPath, 'utf8')).toBe(`${process.pid}\n`);
          return reply;
        }),
      );
      expect(pong.type).toBe('pong');
      expect(existsSync(config.lockTargetPath)).toBe(false);
    }));

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
