import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'effect-rstest';
import * as Deferred from 'effect/Deferred';
import * as Effect from 'effect/Effect';
import * as Fiber from 'effect/Fiber';
import * as TestClock from 'effect/testing/TestClock';

import type { DaemonConfigShape } from '../src/daemon/config.js';
import {
  acquireSingletonLockWith,
  claimStaleLock,
  DaemonAlreadyRunningError,
  makeSingletonCompromiseController,
  SingletonLockError,
  type SingletonLockDependencies,
} from '../src/daemon/singleton.js';
import { scopedTempDir } from './harness.js';

const config = {
  stateDir: '/tmp/cargo-hauler-singleton-test',
  socketPath: '/tmp/cargo-hauler-singleton-test/daemon.sock',
  databasePath: '/tmp/cargo-hauler-singleton-test/ledger.db',
  lockTargetPath: '/tmp/cargo-hauler-singleton-test/daemon.pid',
  logPath: '/tmp/cargo-hauler-singleton-test/daemon.log',
} as DaemonConfigShape;

const makeDependencies = (
  overrides: Partial<SingletonLockDependencies> = {},
): SingletonLockDependencies => ({
  acquire: async () => async () => undefined,
  bootTimeMs: () => 0,
  currentPid: 4242,
  lockMtimeMs: async () => 0,
  now: () => 30_000,
  prepare: async () => undefined,
  processLiveness: () => 'dead',
  readPid: async () => '',
  removeOwnPid: async () => undefined,
  removeStaleLock: async () => 'claimed',
  socketAnswers: () => Effect.succeed(false),
  writePid: async () => undefined,
  ...overrides,
});

const heldError = (): Error => Object.assign(new Error('held'), { code: 'ELOCKED' });

/**
 * A lock that stays held until the stale-lock reclaim runs and is free
 * afterwards, recording every dependency call so the recovery order can be
 * asserted.
 */
const heldUntilReclaimedDependencies = (
  events: string[],
  overrides: Partial<SingletonLockDependencies> = {},
): SingletonLockDependencies => {
  let attempts = 0;
  let reclaimed = false;
  return makeDependencies({
    acquire: async () => {
      attempts += 1;
      events.push(`acquire:${attempts}`);
      if (!reclaimed) {
        throw heldError();
      }
      return async () => {
        events.push('release');
      };
    },
    removeOwnPid: async (_path, pid) => {
      events.push(`remove-pid:${pid}`);
    },
    removeStaleLock: async (_path, pid) => {
      events.push(`remove-stale:${pid}`);
      reclaimed = true;
      return 'claimed';
    },
    writePid: async (_path, pid) => {
      events.push(`write-pid:${pid}`);
    },
    ...overrides,
  });
};

const withoutAttemptNumbers = (events: readonly string[]): string[] =>
  events.map((event) => (event.startsWith('acquire:') ? 'acquire' : event));

interface WallClock {
  now: number;
}

/** Advance both the test clock and the wall clock the lock code reads. */
const advanceSeconds = (clock: WallClock, seconds: number): Effect.Effect<void> =>
  Effect.gen(function* () {
    for (let index = 0; index < seconds; index += 1) {
      clock.now += 1_000;
      yield* TestClock.adjust('1 second');
    }
  });

/** Advance one second at a time until the fiber settles, bounded. */
const advanceUntilSettled = <A, E>(
  clock: WallClock,
  fiber: Fiber.Fiber<A, E>,
  maxSeconds: number,
): Effect.Effect<A, E> =>
  Effect.gen(function* () {
    for (let index = 0; index < maxSeconds && fiber.pollUnsafe() === undefined; index += 1) {
      yield* advanceSeconds(clock, 1);
    }
    return yield* Fiber.join(fiber);
  });

describe('makeSingletonCompromiseController', () => {
  it.effect('signals fatal teardown and arms a forced-exit fallback without exiting immediately', () =>
    Effect.gen(function* () {
      const fatalShutdown = Deferred.makeUnsafe<Error>();
      const stderr: string[] = [];
      let exitCode: number | undefined;
      let forceExit: (() => void) | undefined;
      let forcedCode: number | undefined;

      const controller = makeSingletonCompromiseController(fatalShutdown, {
        scheduleForceExit: (callback) => {
          forceExit = callback;
          return () => {
            forceExit = undefined;
          };
        },
        setExitCode: (code) => {
          exitCode = code;
        },
        forceExit: (code) => {
          forcedCode = code;
        },
        writeStderr: (message) => {
          stderr.push(message);
        },
      });

      const compromise = new Error('ownership lost');
      controller.onCompromised(compromise);

      expect(yield* Deferred.await(fatalShutdown)).toBe(compromise);
      expect(exitCode).toBe(1);
      expect(stderr.join('')).toContain('singleton lock compromised: ownership lost');
      expect(forcedCode).toBeUndefined();

      forceExit?.();
      expect(forcedCode).toBe(1);
    }));
});

describe('acquireSingletonLockWith', () => {
  it.effect('fails closed without removing a lock when its live daemon answers', () =>
    Effect.gen(function* () {
      let removed = 0;
      let writes = 0;
      const error = yield* Effect.flip(
        acquireSingletonLockWith(
          config,
          makeDependencies({
            acquire: async () => {
              throw Object.assign(new Error('held'), { code: 'ELOCKED' });
            },
            readPid: async () => '9001\n',
            removeStaleLock: async () => {
              removed += 1;
              return 'claimed';
            },
            socketAnswers: () => Effect.succeed(true),
            writePid: async () => {
              writes += 1;
            },
          }),
        ),
      );

      expect(error).toBeInstanceOf(DaemonAlreadyRunningError);
      expect(removed).toBe(0);
      expect(writes).toBe(0);
    }));

  it.effect('explicitly removes a stale lock owned by a dead pid and rewrites the pid record', () =>
    Effect.gen(function* () {
      const events: string[] = [];
      // The lock's release events fire when its scope closes, so the lock
      // gets an inner scope that ends before the assertions.
      yield* Effect.scoped(
        acquireSingletonLockWith(
          config,
          heldUntilReclaimedDependencies(events, {
            lockMtimeMs: async () => 1_000,
            processLiveness: (pid) => {
              expect(pid).toBe(1111);
              return 'dead';
            },
            readPid: async () => '1111\n',
          }),
        ),
      );

      expect(events).toEqual([
        'acquire:1',
        'remove-stale:4242',
        'acquire:2',
        'write-pid:4242',
        'remove-pid:4242',
        'release',
      ]);
    }));

  it.effect('keeps polling a fresh lock whose daemon never answers and reclaims it once stale', () =>
    Effect.gen(function* () {
      // An unclean death (SIGKILL, OOM) leaves a lock whose mtime is only a
      // few seconds old: a single check sees "fresh" and gives up, and the
      // spawning client never retries. The recovery loop must outlast the
      // stale window instead.
      const events: string[] = [];
      const clock = { now: 30_000 };
      const dependencies = heldUntilReclaimedDependencies(events, {
        lockMtimeMs: async () => 25_000,
        now: () => clock.now,
        processLiveness: () => 'dead',
        readPid: async () => '1111\n',
      });
      const acquiring = yield* Effect.forkChild(
        Effect.scoped(acquireSingletonLockWith(config, dependencies)),
      );

      yield* advanceSeconds(clock, 5);
      expect(events.length).toBeGreaterThanOrEqual(2);
      expect(new Set(withoutAttemptNumbers(events))).toEqual(new Set(['acquire']));

      // The lock ages past staleMs (15 s) once now > 40 s.
      yield* advanceUntilSettled(clock, acquiring, 15);

      const reclaimAt = events.indexOf('remove-stale:4242');
      expect(reclaimAt).toBeGreaterThan(0);
      expect(withoutAttemptNumbers(events.slice(reclaimAt))).toEqual([
        'remove-stale:4242',
        'acquire',
        'write-pid:4242',
        'remove-pid:4242',
        'release',
      ]);
    }));

  it.effect('stops polling as soon as the held lock\'s daemon answers', () =>
    Effect.gen(function* () {
      const clock = { now: 30_000 };
      let pings = 0;
      const dependencies = makeDependencies({
        acquire: async () => {
          throw heldError();
        },
        lockMtimeMs: async () => clock.now - 1_000,
        now: () => clock.now,
        socketAnswers: () => {
          pings += 1;
          return Effect.succeed(pings >= 3);
        },
      });
      const acquiring = yield* Effect.forkChild(
        Effect.flip(Effect.scoped(acquireSingletonLockWith(config, dependencies))),
      );

      const error = yield* advanceUntilSettled(clock, acquiring, 10);

      expect(error).toBeInstanceOf(DaemonAlreadyRunningError);
      expect(pings).toBe(3);
    }));

  it.effect('gives up on a lock that stays fresh and unanswered past the recovery window', () =>
    Effect.gen(function* () {
      const clock = { now: 30_000 };
      let inspections = 0;
      const dependencies = makeDependencies({
        acquire: async () => {
          throw heldError();
        },
        lockMtimeMs: async () => {
          inspections += 1;
          return clock.now - 1_000;
        },
        now: () => clock.now,
      });
      const acquiring = yield* Effect.forkChild(
        Effect.flip(Effect.scoped(acquireSingletonLockWith(config, dependencies))),
      );

      const error = yield* advanceUntilSettled(clock, acquiring, 40);

      expect(error).toBeInstanceOf(SingletonLockError);
      expect(String((error as SingletonLockError).cause)).toContain('not yet answering');
      // Polled at ~1 s for staleMs (15 s) plus a margin, not checked once.
      expect(inspections).toBeGreaterThanOrEqual(2);
      expect(inspections).toBeLessThanOrEqual(25);
      expect(clock.now - 30_000).toBeGreaterThanOrEqual(15_000);
      expect(clock.now - 30_000).toBeLessThanOrEqual(30_000);
    }));

  it.effect('treats a lock older than boot as stale even when its recorded pid is alive', () =>
    Effect.gen(function* () {
      // The state dir persists across reboots, so a pre-reboot lock whose
      // pid has since been reused by an unrelated process is realistic.
      const events: string[] = [];
      yield* Effect.scoped(
        acquireSingletonLockWith(
          config,
          heldUntilReclaimedDependencies(events, {
            bootTimeMs: () => 29_000,
            lockMtimeMs: async () => 28_000,
            processLiveness: () => 'alive',
            readPid: async () => '1111\n',
          }),
        ),
      );

      expect(events.slice(0, 3)).toEqual(['acquire:1', 'remove-stale:4242', 'acquire:2']);
    }));

  it.effect('treats an EPERM owner as unknown: reclaims a pre-boot lock, fails closed on a live-boot one', () =>
    Effect.gen(function* () {
      const reclaimed: string[] = [];
      yield* Effect.scoped(
        acquireSingletonLockWith(
          config,
          heldUntilReclaimedDependencies(reclaimed, {
            bootTimeMs: () => 29_000,
            lockMtimeMs: async () => 1_000,
            processLiveness: () => 'unknown',
            readPid: async () => '1111\n',
          }),
        ),
      );
      expect(reclaimed).toContain('remove-stale:4242');

      const refused: string[] = [];
      const error = yield* Effect.flip(
        acquireSingletonLockWith(
          config,
          heldUntilReclaimedDependencies(refused, {
            bootTimeMs: () => 0,
            lockMtimeMs: async () => 1_000,
            processLiveness: () => 'unknown',
            readPid: async () => '1111\n',
          }),
        ),
      );
      expect(error).toBeInstanceOf(SingletonLockError);
      expect(String((error as SingletonLockError).cause)).toContain('1111');
      expect(refused).toEqual(['acquire:1']);
    }));

  it.effect('yields to a competing starter that claims the stale lock first', () =>
    Effect.gen(function* () {
      const events: string[] = [];
      let attempts = 0;
      const error = yield* Effect.flip(
        acquireSingletonLockWith(
          config,
          makeDependencies({
            acquire: async () => {
              attempts += 1;
              events.push(`acquire:${attempts}`);
              throw heldError();
            },
            lockMtimeMs: async () => 1_000,
            readPid: async () => '1111\n',
            removeStaleLock: async () => {
              events.push('remove-stale');
              return 'lost';
            },
            // The winner is answering by the time we look again.
            socketAnswers: () => Effect.succeed(attempts >= 2),
          }),
        ),
      );

      expect(error).toBeInstanceOf(DaemonAlreadyRunningError);
      expect(events).toEqual(['acquire:1', 'remove-stale', 'acquire:2']);
    }));

  it.effect('acquires a missing lock directly and records its pid', () =>
    Effect.gen(function* () {
      const events: string[] = [];
      yield* Effect.scoped(
        acquireSingletonLockWith(
          config,
          makeDependencies({
            acquire: async () => {
              events.push('acquire');
              return async () => {
                events.push('release');
              };
            },
            removeOwnPid: async (_path, pid) => {
              events.push(`remove-pid:${pid}`);
            },
            writePid: async (_path, pid) => {
              events.push(`write-pid:${pid}`);
            },
          }),
        ),
      );

      expect(events).toEqual(['acquire', 'write-pid:4242', 'remove-pid:4242', 'release']);
    }));
});

describe('claimStaleLock', () => {
  it.live('lets exactly one of two concurrent starters remove the lock directory', () =>
    Effect.gen(function* () {
      const stateDir = yield* scopedTempDir('cargo-hauler-claim-');
      const lockTargetPath = join(stateDir, 'daemon.pid');
      mkdirSync(`${lockTargetPath}.lock`);

      const outcomes = yield* Effect.promise(() =>
        Promise.all([claimStaleLock(lockTargetPath, 1001), claimStaleLock(lockTargetPath, 1002)]),
      );

      expect([...outcomes].sort()).toEqual(['claimed', 'lost']);
      expect(existsSync(`${lockTargetPath}.lock`)).toBe(false);
      expect(readdirSync(stateDir)).toEqual([]);
    }));

  it.live('reports lost when the lock directory is already gone', () =>
    Effect.gen(function* () {
      const stateDir = yield* scopedTempDir('cargo-hauler-claim-gone-');
      expect(yield* Effect.promise(() => claimStaleLock(join(stateDir, 'daemon.pid'), 7))).toBe(
        'lost',
      );
    }));
});
