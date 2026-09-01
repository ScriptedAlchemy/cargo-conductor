import { availableParallelism } from 'node:os';
import { join } from 'node:path';

import * as Context from 'effect/Context';
import * as Layer from 'effect/Layer';

import { daemonSocketPath, defaultKacheIndexPath, resolveStateDir } from '../status.js';

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
  /**
   * Brief admission delay for a batchable lane head so near-simultaneous
   * agent requests can fold before the first process starts (0 disables).
   */
  readonly batchWindowMs: number;
  /**
   * Per-core 1-minute loadavg above which admission defers (opt-in via
   * CARGO_HAULER_LOAD_THRESHOLD; null disables the clamp entirely).
   */
  readonly loadThresholdPerCore: number | null;
  /** Admissions the load clamp never throttles below (floor 1). */
  readonly loadMinConcurrent: number;
  /**
   * PSI `some avg10` CPU stall percentage above which admission defers.
   * On by default where /proc/pressure exists because stall share, unlike
   * loadavg, reacts within seconds to the contention that makes concurrent
   * test suites miss deadlines. CARGO_HAULER_CPU_PRESSURE_THRESHOLD
   * overrides; any value <= 0 disables the arm.
   */
  readonly cpuStallThreshold: number | null;
}

export class DaemonConfig extends Context.Service<DaemonConfig, DaemonConfigShape>()(
  'cargo-hauler/DaemonConfig',
) {}

const defaultMaxConcurrent = 5;
const defaultCpuStallThreshold = 75;
const defaultBatchWindowMs = 150;

export const resolveDaemonConfig = (
  env: Readonly<Record<string, string | undefined>> = process.env,
  platform: NodeJS.Platform = process.platform,
): DaemonConfigShape => {
  const stateDir = resolveStateDir(env);
  // Backward compatibility: each CARGO_HAULER_* setting wins when present,
  // while the corresponding CARGO_CONDUCTOR_* setting remains a fallback for
  // operator environments created before the rebrand.
  const maxConcurrentValue =
    env.CARGO_HAULER_MAX_CONCURRENT ?? env.CARGO_CONDUCTOR_MAX_CONCURRENT;
  const replayBufferValue =
    env.CARGO_HAULER_REPLAY_BUFFER_BYTES ?? env.CARGO_CONDUCTOR_REPLAY_BUFFER_BYTES;
  const jobsGrantValue = env.CARGO_HAULER_JOBS_GRANT ?? env.CARGO_CONDUCTOR_JOBS_GRANT;
  const loadThresholdValue =
    env.CARGO_HAULER_LOAD_THRESHOLD ?? env.CARGO_CONDUCTOR_LOAD_THRESHOLD;
  const loadMinValue = env.CARGO_HAULER_LOAD_MIN ?? env.CARGO_CONDUCTOR_LOAD_MIN;
  const cpuPressureValue =
    env.CARGO_HAULER_CPU_PRESSURE_THRESHOLD ?? env.CARGO_CONDUCTOR_CPU_PRESSURE_THRESHOLD;
  const batchValue = env.CARGO_HAULER_BATCH ?? env.CARGO_CONDUCTOR_BATCH;
  const batchWindowValue =
    env.CARGO_HAULER_BATCH_WINDOW_MS ?? env.CARGO_CONDUCTOR_BATCH_WINDOW_MS;
  const kacheIndexValue =
    env.CARGO_HAULER_KACHE_INDEX ?? env.CARGO_CONDUCTOR_KACHE_INDEX;
  const parsedMax = Number.parseInt(maxConcurrentValue ?? '', 10);
  const parsedReplay = Number.parseInt(replayBufferValue ?? '', 10);
  const maxConcurrent =
    Number.isInteger(parsedMax) && parsedMax > 0 ? parsedMax : defaultMaxConcurrent;
  const parsedJobs = Number.parseInt(jobsGrantValue ?? '', 10);
  const parsedLoadThreshold = Number.parseFloat(loadThresholdValue ?? '');
  const parsedLoadMin = Number.parseInt(loadMinValue ?? '', 10);
  const parsedCpuStall = Number.parseFloat(cpuPressureValue ?? '');
  const parsedBatchWindow = Number.parseInt(batchWindowValue ?? '', 10);
  // Divide the cores between the admitted builds so N concurrent cargos do
  // not each assume they own the whole machine (rheo's grant idea).
  const defaultJobsGrant = Math.max(4, Math.floor(availableParallelism() / maxConcurrent));
  return {
    stateDir,
    socketPath: daemonSocketPath(stateDir, platform),
    databasePath: join(stateDir, 'ledger.db'),
    lockTargetPath: join(stateDir, 'daemon.pid'),
    logPath: join(stateDir, 'daemon.log'),
    maxConcurrent,
    outputTailBytes: 16 * 1024,
    replayBufferBytes:
      Number.isInteger(parsedReplay) && parsedReplay >= 0 ? parsedReplay : 4 * 1024 * 1024,
    // '' (explicitly empty) disables kache; a missing default file merely
    // reports kache as unavailable, so no machine needs the path to exist.
    kacheIndexPath: kacheIndexValue ?? defaultKacheIndexPath(env),
    jobsGrant: Number.isInteger(parsedJobs) && parsedJobs >= 0 ? parsedJobs : defaultJobsGrant,
    batchEnabled: batchValue !== '0',
    batchWindowMs:
      Number.isInteger(parsedBatchWindow) && parsedBatchWindow >= 0
        ? parsedBatchWindow
        : defaultBatchWindowMs,
    loadThresholdPerCore:
      Number.isFinite(parsedLoadThreshold) && parsedLoadThreshold > 0 ? parsedLoadThreshold : null,
    loadMinConcurrent:
      Number.isInteger(parsedLoadMin) && parsedLoadMin >= 1 ? parsedLoadMin : 2,
    cpuStallThreshold:
      cpuPressureValue === undefined
        ? defaultCpuStallThreshold
        : Number.isFinite(parsedCpuStall) && parsedCpuStall > 0
          ? parsedCpuStall
          : null,
  };
};

export const DaemonConfigLive = Layer.sync(DaemonConfig, () => resolveDaemonConfig());
