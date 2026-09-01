import { join } from 'node:path';

import * as Context from 'effect/Context';
import * as Layer from 'effect/Layer';

import { conductorStateRoot } from '../status.js';

/** Filesystem layout and concurrency settings for one daemon instance. */
export interface DaemonConfigShape {
  readonly stateDir: string;
  readonly socketPath: string;
  readonly databasePath: string;
  /** File guarded by proper-lockfile to enforce the daemon singleton. */
  readonly lockTargetPath: string;
  /** Stdout/stderr destination when the daemon is spawned detached. */
  readonly logPath: string;
  /** Machine-wide cap on concurrently running cargo processes (admission permits). */
  readonly maxConcurrent: number;
  /** Bytes of combined stdout+stderr retained per request in the ledger. */
  readonly outputTailBytes: number;
  /** Bytes of leader output retained in memory for late-attacher replay. */
  readonly replayBufferBytes: number;
}

export class DaemonConfig extends Context.Tag('cargo-conductor/DaemonConfig')<
  DaemonConfig,
  DaemonConfigShape
>() {}

const defaultMaxConcurrent = 5;

export const resolveDaemonConfig = (
  env: Readonly<Record<string, string | undefined>> = process.env,
): DaemonConfigShape => {
  const stateDir = env.CARGO_CONDUCTOR_STATE_DIR ?? conductorStateRoot;
  const parsedMax = Number.parseInt(env.CARGO_CONDUCTOR_MAX_CONCURRENT ?? '', 10);
  const parsedReplay = Number.parseInt(env.CARGO_CONDUCTOR_REPLAY_BUFFER_BYTES ?? '', 10);
  return {
    stateDir,
    socketPath: join(stateDir, 'daemon.sock'),
    databasePath: join(stateDir, 'ledger.db'),
    lockTargetPath: join(stateDir, 'daemon.pid'),
    logPath: join(stateDir, 'daemon.log'),
    maxConcurrent: Number.isInteger(parsedMax) && parsedMax > 0 ? parsedMax : defaultMaxConcurrent,
    outputTailBytes: 16 * 1024,
    replayBufferBytes:
      Number.isInteger(parsedReplay) && parsedReplay >= 0 ? parsedReplay : 4 * 1024 * 1024,
  };
};

export const DaemonConfigLive = Layer.sync(DaemonConfig, () => resolveDaemonConfig());
