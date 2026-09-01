import { describe, expect, it } from '@rstest/core';
import * as Deferred from 'effect/Deferred';
import * as Effect from 'effect/Effect';

import { makeSingletonCompromiseController } from '../src/daemon/singleton.js';

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
