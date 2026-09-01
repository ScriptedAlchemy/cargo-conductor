import { describe, expect, it } from '@rstest/core';

import { makeSignalShutdownController } from '../src/daemon/lifecycle.js';

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
