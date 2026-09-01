import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';

import * as Effect from 'effect/Effect';
import * as Schedule from 'effect/Schedule';

import { resolveDaemonConfig } from '../daemon/config.js';
import type { DaemonConfigShape } from '../daemon/config.js';
import { pingDaemon } from '../daemon/control.js';
import type { PongMessage } from '../daemon/protocol.js';

export const waitForDaemon = (
  socketPath: string,
): Effect.Effect<PongMessage, unknown> =>
  pingDaemon(socketPath, 1_000).pipe(
    Effect.retry(Schedule.spaced('150 millis').pipe(Schedule.intersect(Schedule.recurs(40)))),
  );

export const spawnDetachedDaemon = (
  config: DaemonConfigShape,
  entryPath: string = process.argv[1] ?? '',
): Effect.Effect<void> =>
  Effect.sync(() => {
    mkdirSync(config.stateDir, { recursive: true });
    const logFd = openSync(config.logPath, 'a');
    const child = spawn(process.execPath, [entryPath, 'daemon', 'run'], {
      detached: true,
      env: { ...process.env, CARGO_CONDUCTOR_STATE_DIR: config.stateDir },
      stdio: ['ignore', logFd, logFd],
    });
    child.unref();
    closeSync(logFd);
  });

export const ensureDaemonRunning = (
  config: DaemonConfigShape = resolveDaemonConfig(),
): Effect.Effect<PongMessage, unknown> =>
  Effect.gen(function* () {
    const already = yield* pingDaemon(config.socketPath, 500).pipe(
      Effect.map((pong) => pong),
      Effect.catchAll(() => Effect.succeed(null)),
    );
    if (already !== null) {
      return already;
    }
    yield* spawnDetachedDaemon(config);
    return yield* waitForDaemon(config.socketPath);
  });
