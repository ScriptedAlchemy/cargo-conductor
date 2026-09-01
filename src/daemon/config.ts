import { availableParallelism } from 'node:os';
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
  /** kache index.db to read per-crate compile-time priors from ('' disables). */
  readonly kacheIndexPath: string;
  /** CARGO_BUILD_JOBS granted to each spawned cargo (0 disables injection). */
  readonly jobsGrant: number;
  /** Merge queued compatible check/build/clippy intents into one cargo. */
  readonly batchEnabled: boolean;
}

export class DaemonConfig extends Context.Service<DaemonConfig, DaemonConfigShape>()(
  'cargo-conductor/DaemonConfig',
) {}

const defaultMaxConcurrent = 5;

export const resolveDaemonConfig = (
  env: Readonly<Record<string, string | undefined>> = process.env,
): DaemonConfigShape => {
  const stateDir = env.CARGO_CONDUCTOR_STATE_DIR ?? conductorStateRoot;
  const parsedMax = Number.parseInt(env.CARGO_CONDUCTOR_MAX_CONCURRENT ?? '', 10);
  const parsedReplay = Number.parseInt(env.CARGO_CONDUCTOR_REPLAY_BUFFER_BYTES ?? '', 10);
  const maxConcurrent =
    Number.isInteger(parsedMax) && parsedMax > 0 ? parsedMax : defaultMaxConcurrent;
  const parsedJobs = Number.parseInt(env.CARGO_CONDUCTOR_JOBS_GRANT ?? '', 10);
  // Divide the cores between the admitted builds so N concurrent cargos do
  // not each assume they own the whole machine (rheo's grant idea).
  const defaultJobsGrant = Math.max(4, Math.floor(availableParallelism() / maxConcurrent));
  return {
    stateDir,
    socketPath: join(stateDir, 'daemon.sock'),
    databasePath: join(stateDir, 'ledger.db'),
    lockTargetPath: join(stateDir, 'daemon.pid'),
    logPath: join(stateDir, 'daemon.log'),
    maxConcurrent,
    outputTailBytes: 16 * 1024,
    replayBufferBytes:
      Number.isInteger(parsedReplay) && parsedReplay >= 0 ? parsedReplay : 4 * 1024 * 1024,
    kacheIndexPath: env.CARGO_CONDUCTOR_KACHE_INDEX ?? '/fast/cache/kache/index.db',
    jobsGrant: Number.isInteger(parsedJobs) && parsedJobs >= 0 ? parsedJobs : defaultJobsGrant,
    batchEnabled: env.CARGO_CONDUCTOR_BATCH !== '0',
  };
};

export const DaemonConfigLive = Layer.sync(DaemonConfig, () => resolveDaemonConfig());
