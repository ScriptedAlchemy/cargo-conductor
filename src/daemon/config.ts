import { availableParallelism } from 'node:os';
import { join } from 'node:path';

import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';

import { daemonSocketPath, defaultKacheIndexPath, resolveStateDir } from '../status.js';

import { ticketLogDirFor } from './ticket-log.js';

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
  /** Directory of per-ticket full output logs (`<stateDir>/tickets`). */
  readonly ticketLogDir: string;
  /**
   * Bytes of a leader's combined output written to its on-disk ticket log
   * before the log is truncated with a final notice
   * (CARGO_HAULER_TICKET_LOG_MAX_BYTES; 0 disables ticket logs).
   */
  readonly ticketLogMaxBytes: number;
  /** Bytes of leader output retained in memory for late-attacher replay. */
  readonly replayBufferBytes: number;
  /** kache index.db to read per-crate compile-time priors from ('' disables). */
  readonly kacheIndexPath: string;
  /**
   * CARGO_BUILD_JOBS granted to each spawned cargo while the shared jobserver
   * FIFO is not armed (0 disables injection). An armed daemon injects
   * MAKEFLAGS instead, since cargo ignores an inherited jobserver once -j is set.
   */
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
  /**
   * Linux PSI memory `full avg10` soft threshold. Defers above the normal
   * concurrency floor; null disables this arm.
   */
  readonly memPressureSoftThreshold: number | null;
  /**
   * Linux PSI memory `full avg10` hard threshold. Hard admission also
   * requires `full avg60 >= threshold / 2` to reject transient spikes.
   */
  readonly memPressureHardThreshold: number | null;
  /** Linux MemAvailable hard floor in bytes; null disables this arm. */
  readonly memAvailableMinBytes: number | null;
  /** macOS VM pressure level that enables soft admission; null disables it. */
  readonly memPressureLevelThreshold: 2 | 4 | null;
  /**
   * Linux MemAvailable in bytes below which concurrent heavy leaders
   * (release/perf/bench profiles, workspace-wide runs) are capped; null
   * disables the cap.
   */
  readonly heavyMemAvailableBytes: number | null;
  /** Heavy leaders admitted at once while the cap is active (floor 1). */
  readonly heavyMaxConcurrent: number;
  /**
   * Days a finished ledger row is kept before the startup retention pass
   * deletes it (CARGO_HAULER_LEDGER_RETENTION_DAYS; 0 disables the age limit).
   */
  readonly ledgerRetentionDays: number;
  /**
   * Total ledger rows beyond which the oldest finished rows are deleted at
   * startup (CARGO_HAULER_LEDGER_MAX_ROWS; 0 disables the row cap).
   */
  readonly ledgerMaxRows: number;
}

export class DaemonConfig extends Context.Service<DaemonConfig, DaemonConfigShape>()(
  'cargo-hauler/DaemonConfig',
) {}

const defaultMaxConcurrent = 5;
const defaultReplayBufferBytes = 4 * 1024 * 1024;
const defaultLoadMinConcurrent = 2;
const defaultCpuStallThreshold = 75;
const defaultBatchWindowMs = 150;
const defaultMemPressureSoftThreshold = 10;
const defaultMemPressureHardThreshold = 20;
const defaultMemAvailableMinGb = 8;
const defaultMemPressureLevelThreshold = 2;
const defaultHeavyMemAvailableGb = 16;
const defaultHeavyMaxConcurrent = 1;
const defaultLedgerRetentionDays = 30;
const defaultLedgerMaxRows = 50_000;
const gibibyte = 1024 ** 3;
const defaultTicketLogMaxBytes = 64 * 1024 * 1024;

export type ConfigWarningSink = (warning: string) => void;

const writeWarningToStderr: ConfigWarningSink = (warning) => {
  process.stderr.write(`[cargo-hauler] ${warning}\n`);
};

/** One environment variable read through its preferred name or legacy alias. */
interface EnvValue {
  readonly name: string;
  readonly raw: string | undefined;
}

interface NumberEnvOptions {
  /** Inclusive lower bound. */
  readonly min?: number;
  /** Inclusive upper bound. */
  readonly max?: number;
  readonly integer?: boolean;
}

const describeRange = (options: NumberEnvOptions): string => {
  const kind = options.integer === true ? 'an integer' : 'a number';
  if (options.min !== undefined && options.max !== undefined) {
    return `${kind} between ${options.min} and ${options.max}`;
  }
  if (options.min !== undefined) {
    return `${kind} >= ${options.min}`;
  }
  if (options.max !== undefined) {
    return `${kind} <= ${options.max}`;
  }
  return kind;
};

const parseBoundedNumber = (raw: string, options: NumberEnvOptions): number | null => {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  if (options.integer === true && !Number.isInteger(parsed)) {
    return null;
  }
  if (options.min !== undefined && parsed < options.min) {
    return null;
  }
  if (options.max !== undefined && parsed > options.max) {
    return null;
  }
  return parsed;
};

/** Spellings that turn an optional arm off, in addition to a non-positive number. */
const disableTokens = new Set(['off', 'false', 'no', 'none', 'disabled']);

const isDisableToken = (raw: string): boolean => disableTokens.has(raw.trim().toLowerCase());

const falseTokens = new Set(['0', 'false', 'off', 'no']);
const trueTokens = new Set(['1', 'true', 'on', 'yes']);

const pick = (
  env: Readonly<Record<string, string | undefined>>,
  preferred: string,
  legacy?: string,
): EnvValue => {
  if (env[preferred] !== undefined) {
    return { name: preferred, raw: env[preferred] };
  }
  if (legacy !== undefined && env[legacy] !== undefined) {
    return { name: legacy, raw: env[legacy] };
  }
  return { name: preferred, raw: undefined };
};

/**
 * Builds the parsing helpers around one warning sink so an unparseable or
 * out-of-range value keeps the documented default and says so, instead of
 * silently changing behaviour (previously `abc` disabled a pressure arm).
 */
const envParsers = (warn: ConfigWarningSink) => {
  const number = (value: EnvValue, fallback: number, options: NumberEnvOptions = {}): number => {
    if (value.raw === undefined) {
      return fallback;
    }
    const parsed = parseBoundedNumber(value.raw, options);
    if (parsed === null) {
      warn(
        `${value.name}=${JSON.stringify(value.raw)} is not ${describeRange(options)}; using ${fallback}`,
      );
      return fallback;
    }
    return parsed;
  };

  /**
   * Optional arm: `off` (and friends) or a number <= 0 disables it (null);
   * a positive number within range sets it; anything else warns and keeps the
   * fallback.
   */
  const optionalNumber = (
    value: EnvValue,
    fallback: number | null,
    options: NumberEnvOptions = {},
  ): number | null => {
    if (value.raw === undefined) {
      return fallback;
    }
    if (isDisableToken(value.raw)) {
      return null;
    }
    const numeric = Number(value.raw.trim());
    if (value.raw.trim().length > 0 && Number.isFinite(numeric) && numeric <= 0) {
      return null;
    }
    const parsed = parseBoundedNumber(value.raw, { ...options, min: options.min ?? 0 });
    if (parsed === null) {
      warn(
        `${value.name}=${JSON.stringify(value.raw)} is not ${describeRange({
          ...options,
          min: options.min ?? 0,
        })} or off; using ${fallback ?? 'off'}`,
      );
      return fallback;
    }
    return parsed;
  };

  const flag = (value: EnvValue, fallback: boolean): boolean => {
    if (value.raw === undefined) {
      return fallback;
    }
    const normalized = value.raw.trim().toLowerCase();
    if (falseTokens.has(normalized)) {
      return false;
    }
    if (trueTokens.has(normalized)) {
      return true;
    }
    warn(
      `${value.name}=${JSON.stringify(value.raw)} is not one of 1/true/on/yes or 0/false/off/no; using ${fallback ? 'enabled' : 'disabled'}`,
    );
    return fallback;
  };

  return { flag, number, optionalNumber };
};

export interface ResolvedDaemonConfig {
  readonly config: DaemonConfigShape;
  readonly warnings: readonly string[];
}

export const resolveDaemonConfigWithWarnings = (
  env: Readonly<Record<string, string | undefined>> = process.env,
  platform: NodeJS.Platform = process.platform,
): ResolvedDaemonConfig => {
  const warnings: string[] = [];
  const { flag, number, optionalNumber } = envParsers((warning) => {
    warnings.push(warning);
  });
  const stateDir = resolveStateDir(env);
  // Legacy aliases remain compatible only when a stale value cannot select
  // persistent daemon identity. Tuning values and the read-only kache index
  // are safe; state, socket, and database locations accept CARGO_HAULER_* only.
  const maxConcurrent = number(
    pick(env, 'CARGO_HAULER_MAX_CONCURRENT', 'CARGO_CONDUCTOR_MAX_CONCURRENT'),
    defaultMaxConcurrent,
    { integer: true, min: 1 },
  );
  const kacheIndexValue = env.CARGO_HAULER_KACHE_INDEX ?? env.CARGO_CONDUCTOR_KACHE_INDEX;
  // Divide the cores between the admitted builds so N concurrent cargos do
  // not each assume they own the whole machine (rheo's grant idea).
  const defaultJobsGrant = Math.max(4, Math.floor(availableParallelism() / maxConcurrent));
  const linuxOnly = (value: number | null): number | null => (platform === 'linux' ? value : null);

  let memPressureSoftThreshold = linuxOnly(
    optionalNumber(pick(env, 'CARGO_HAULER_MEM_PRESSURE_SOFT'), defaultMemPressureSoftThreshold, {
      max: 100,
    }),
  );
  let memPressureHardThreshold = linuxOnly(
    optionalNumber(pick(env, 'CARGO_HAULER_MEM_PRESSURE_HARD'), defaultMemPressureHardThreshold, {
      max: 100,
    }),
  );
  if (
    memPressureSoftThreshold !== null &&
    memPressureHardThreshold !== null &&
    memPressureSoftThreshold >= memPressureHardThreshold
  ) {
    warnings.push(
      `CARGO_HAULER_MEM_PRESSURE_SOFT (${memPressureSoftThreshold}) must be below CARGO_HAULER_MEM_PRESSURE_HARD (${memPressureHardThreshold}); using ${defaultMemPressureSoftThreshold}/${defaultMemPressureHardThreshold}`,
    );
    memPressureSoftThreshold = defaultMemPressureSoftThreshold;
    memPressureHardThreshold = defaultMemPressureHardThreshold;
  }

  const memAvailableMinGb = linuxOnly(
    optionalNumber(pick(env, 'CARGO_HAULER_MEM_AVAILABLE_MIN_GB'), defaultMemAvailableMinGb),
  );
  const heavyMemAvailableGb = linuxOnly(
    optionalNumber(pick(env, 'CARGO_HAULER_HEAVY_MEM_AVAILABLE_GB'), defaultHeavyMemAvailableGb),
  );
  const memPressureLevel = pick(env, 'CARGO_HAULER_MEM_PRESSURE_LEVEL');
  let memPressureLevelThreshold: 2 | 4 | null = null;
  if (platform === 'darwin') {
    const level = optionalNumber(memPressureLevel, defaultMemPressureLevelThreshold, {
      integer: true,
    });
    if (level === null || level === 2 || level === 4) {
      memPressureLevelThreshold = level;
    } else {
      warnings.push(
        `${memPressureLevel.name}=${JSON.stringify(memPressureLevel.raw)} must be 2 (warn), 4 (critical), or off; using ${defaultMemPressureLevelThreshold}`,
      );
      memPressureLevelThreshold = defaultMemPressureLevelThreshold;
    }
  }

  const config: DaemonConfigShape = {
    stateDir,
    socketPath: daemonSocketPath(stateDir, platform, env),
    databasePath: join(stateDir, 'ledger.db'),
    lockTargetPath: join(stateDir, 'daemon.pid'),
    logPath: join(stateDir, 'daemon.log'),
    maxConcurrent,
    outputTailBytes: 16 * 1024,
    ticketLogDir: ticketLogDirFor(stateDir),
    ticketLogMaxBytes: number(
      pick(env, 'CARGO_HAULER_TICKET_LOG_MAX_BYTES'),
      defaultTicketLogMaxBytes,
      { integer: true, min: 0 },
    ),
    replayBufferBytes: number(
      pick(env, 'CARGO_HAULER_REPLAY_BUFFER_BYTES', 'CARGO_CONDUCTOR_REPLAY_BUFFER_BYTES'),
      defaultReplayBufferBytes,
      { integer: true, min: 0 },
    ),
    // '' (explicitly empty) disables kache; a missing default file merely
    // reports kache as unavailable, so no machine needs the path to exist.
    kacheIndexPath: kacheIndexValue ?? defaultKacheIndexPath(env),
    jobsGrant: number(
      pick(env, 'CARGO_HAULER_JOBS_GRANT', 'CARGO_CONDUCTOR_JOBS_GRANT'),
      defaultJobsGrant,
      { integer: true, min: 0 },
    ),
    batchEnabled: flag(pick(env, 'CARGO_HAULER_BATCH', 'CARGO_CONDUCTOR_BATCH'), true),
    batchWindowMs: number(
      pick(env, 'CARGO_HAULER_BATCH_WINDOW_MS', 'CARGO_CONDUCTOR_BATCH_WINDOW_MS'),
      defaultBatchWindowMs,
      { integer: true, min: 0 },
    ),
    loadThresholdPerCore: optionalNumber(
      pick(env, 'CARGO_HAULER_LOAD_THRESHOLD', 'CARGO_CONDUCTOR_LOAD_THRESHOLD'),
      null,
    ),
    loadMinConcurrent: number(
      pick(env, 'CARGO_HAULER_LOAD_MIN', 'CARGO_CONDUCTOR_LOAD_MIN'),
      defaultLoadMinConcurrent,
      { integer: true, min: 1 },
    ),
    cpuStallThreshold: optionalNumber(
      pick(env, 'CARGO_HAULER_CPU_PRESSURE_THRESHOLD', 'CARGO_CONDUCTOR_CPU_PRESSURE_THRESHOLD'),
      defaultCpuStallThreshold,
      { max: 100 },
    ),
    memPressureSoftThreshold,
    memPressureHardThreshold,
    memAvailableMinBytes: memAvailableMinGb === null ? null : memAvailableMinGb * gibibyte,
    memPressureLevelThreshold,
    heavyMemAvailableBytes: heavyMemAvailableGb === null ? null : heavyMemAvailableGb * gibibyte,
    heavyMaxConcurrent: number(
      pick(env, 'CARGO_HAULER_HEAVY_MAX_CONCURRENT'),
      defaultHeavyMaxConcurrent,
      { integer: true, min: 1 },
    ),
    ledgerRetentionDays: number(
      pick(env, 'CARGO_HAULER_LEDGER_RETENTION_DAYS'),
      defaultLedgerRetentionDays,
      { min: 0 },
    ),
    ledgerMaxRows: number(pick(env, 'CARGO_HAULER_LEDGER_MAX_ROWS'), defaultLedgerMaxRows, {
      integer: true,
      min: 0,
    }),
  };
  return { config, warnings };
};

/**
 * Resolves the daemon configuration, reporting rejected overrides through
 * `onWarning` (stderr by default) before falling back to the documented value.
 */
export const resolveDaemonConfig = (
  env: Readonly<Record<string, string | undefined>> = process.env,
  platform: NodeJS.Platform = process.platform,
  onWarning: ConfigWarningSink = writeWarningToStderr,
): DaemonConfigShape => {
  const resolved = resolveDaemonConfigWithWarnings(env, platform);
  for (const warning of resolved.warnings) {
    onWarning(warning);
  }
  return resolved.config;
};

/** Daemon layer: rejected overrides land in the daemon log at Warning. */
export const DaemonConfigLive: Layer.Layer<DaemonConfig> = Layer.effect(
  DaemonConfig,
  Effect.gen(function* () {
    const resolved = resolveDaemonConfigWithWarnings();
    for (const warning of resolved.warnings) {
      yield* Effect.logWarning(warning);
    }
    return resolved.config;
  }),
);
