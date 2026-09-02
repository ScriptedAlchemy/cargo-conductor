import { describe, expect, it } from '@rstest/core';
import * as Deferred from 'effect/Deferred';
import * as Effect from 'effect/Effect';

import type { DaemonConfigShape } from '../src/daemon/config.js';
import {
  acquireSingletonLockWith,
  DaemonAlreadyRunningError,
  makeSingletonCompromiseController,
  type SingletonLockDependencies,
} from '../src/daemon/singleton.js';

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
  currentPid: 4242,
  isProcessAlive: () => false,
  lockMtimeMs: async () => 0,
  now: () => 30_000,
  prepare: async () => undefined,
  readPid: async () => '',
  removeOwnPid: async () => undefined,
  removeStaleLock: async () => undefined,
  socketAnswers: () => Effect.succeed(false),
  writePid: async () => undefined,
  ...overrides,
});

describe('makeSingletonCompromiseController', () => {
  it('signals fatal teardown and arms a forced-exit fallback without exiting immediately', async () => {
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

    expect(await Effect.runPromise(Deferred.await(fatalShutdown))).toBe(compromise);
    expect(exitCode).toBe(1);
    expect(stderr.join('')).toContain('singleton lock compromised: ownership lost');
    expect(forcedCode).toBeUndefined();

    forceExit?.();
    expect(forcedCode).toBe(1);
  });
});

describe('acquireSingletonLockWith', () => {
  it('fails closed without removing a lock when its live daemon answers', async () => {
    let removed = 0;
    let writes = 0;
    const error = await Effect.runPromise(
      Effect.scoped(
        Effect.flip(
          acquireSingletonLockWith(
            config,
            makeDependencies({
              acquire: async () => {
                throw Object.assign(new Error('held'), { code: 'ELOCKED' });
              },
              readPid: async () => '9001\n',
              removeStaleLock: async () => {
                removed += 1;
              },
              socketAnswers: () => Effect.succeed(true),
              writePid: async () => {
                writes += 1;
              },
            }),
          ),
        ),
      ),
    );

    expect(error).toBeInstanceOf(DaemonAlreadyRunningError);
    expect(removed).toBe(0);
    expect(writes).toBe(0);
  });

  it('explicitly removes a stale lock owned by a dead pid and rewrites the pid record', async () => {
    const events: string[] = [];
    let attempts = 0;
    await Effect.runPromise(
      Effect.scoped(
        acquireSingletonLockWith(
          config,
          makeDependencies({
            acquire: async () => {
              attempts += 1;
              events.push(`acquire:${attempts}`);
              if (attempts === 1) {
                throw Object.assign(new Error('held'), { code: 'ELOCKED' });
              }
              return async () => {
                events.push('release');
              };
            },
            isProcessAlive: (pid) => {
              expect(pid).toBe(1111);
              return false;
            },
            lockMtimeMs: async () => 1_000,
            readPid: async () => '1111\n',
            removeOwnPid: async (_path, pid) => {
              events.push(`remove-pid:${pid}`);
            },
            removeStaleLock: async () => {
              events.push('remove-stale');
            },
            writePid: async (_path, pid) => {
              events.push(`write-pid:${pid}`);
            },
          }),
        ),
      ),
    );

    expect(events).toEqual([
      'acquire:1',
      'remove-stale',
      'acquire:2',
      'write-pid:4242',
      'remove-pid:4242',
      'release',
    ]);
  });

  it('acquires a missing lock directly and records its pid', async () => {
    const events: string[] = [];
    await Effect.runPromise(
      Effect.scoped(
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
      ),
    );

    expect(events).toEqual(['acquire', 'write-pid:4242', 'remove-pid:4242', 'release']);
  });
});
