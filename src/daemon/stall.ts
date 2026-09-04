import { execFile } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';

import * as Cause from 'effect/Cause';
import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as Ref from 'effect/Ref';

import type { DaemonConfigShape } from './config.js';
import type { Job } from './job-state.js';
import type { StallReport } from './protocol.js';
import type { TicketDirectory } from './ticket-directory.js';

/**
 * Stall detection for running leaders (#46). A deadlocked test binary holds
 * its lane for ever at 0% CPU with nothing on stdout; the estimate overrun
 * alone cannot tell it from a slow build, and output silence alone cannot
 * tell it from a long link phase. The three together can: elapsed beyond
 * `stallEstimateFactor` × estimate, no change in the process tree's CPU time
 * for `stallIdleMs`, and no output in that window.
 *
 * Sampling is periodic and cheap (one `/proc` walk or one `ps` on macOS).
 * The verdict lives on the in-memory job only; the ledger never stores it.
 */

/** One process as seen by the platform sampler. */
export interface ProcessStat {
  readonly pid: number;
  readonly ppid: number;
  /** CPU time in 1/100 s clock ticks (user + system, plus reaped children). */
  readonly cpuTicks: number;
}

/**
 * Linux `CLK_TCK` is 100 on every mainstream kernel build; `sysconf` is not
 * reachable from Node without a native module. Only the delta between
 * samples has to be honest, and a wrong constant scales both sides equally.
 */
const clockTicksPerSecond = 100;
const msPerTick = 1_000 / clockTicksPerSecond;

/**
 * Parses one `/proc/<pid>/stat` line. The `comm` field is parenthesised and
 * may itself contain spaces and parentheses, so fields are counted from the
 * last `)`: state, ppid, pgrp, session, tty_nr, tpgid, flags, minflt,
 * cminflt, majflt, cmajflt, utime, stime, cutime, cstime.
 */
export const parseProcStat = (line: string): ProcessStat | null => {
  const open = line.indexOf(' (');
  const close = line.lastIndexOf(')');
  if (open === -1 || close === -1 || close < open) {
    return null;
  }
  const pid = Number(line.slice(0, open));
  const rest = line.slice(close + 2).split(' ');
  const ppid = Number(rest[1]);
  const times = [rest[11], rest[12], rest[13], rest[14]].map((field) => Number(field));
  if (
    !Number.isInteger(pid) ||
    !Number.isInteger(ppid) ||
    times.some((value) => !Number.isFinite(value))
  ) {
    return null;
  }
  return { pid, ppid, cpuTicks: times.reduce((sum, value) => sum + value, 0) };
};

/**
 * Total CPU time (ms) of `rootPid` and every live descendant; null when the
 * root is not in the table (the process is gone or `/proc` was unreadable).
 * Reaped children are already folded into their parent's cutime/cstime.
 */
export const treeCpuMsFromStats = (
  rootPid: number,
  stats: readonly ProcessStat[],
): number | null => {
  const byPid = new Map<number, ProcessStat>();
  const children = new Map<number, number[]>();
  for (const stat of stats) {
    byPid.set(stat.pid, stat);
    const siblings = children.get(stat.ppid);
    if (siblings === undefined) {
      children.set(stat.ppid, [stat.pid]);
    } else {
      siblings.push(stat.pid);
    }
  }
  if (!byPid.has(rootPid)) {
    return null;
  }
  let ticks = 0;
  const seen = new Set<number>();
  const pending = [rootPid];
  while (pending.length > 0) {
    const pid = pending.pop();
    if (pid === undefined || seen.has(pid)) {
      continue;
    }
    seen.add(pid);
    ticks += byPid.get(pid)?.cpuTicks ?? 0;
    pending.push(...(children.get(pid) ?? []));
  }
  return Math.round(ticks * msPerTick);
};

const numericName = /^\d+$/u;

const readLinuxProcStats = (): readonly ProcessStat[] => {
  const stats: ProcessStat[] = [];
  let entries: string[];
  try {
    entries = readdirSync('/proc');
  } catch {
    return stats;
  }
  for (const entry of entries) {
    if (!numericName.test(entry)) {
      continue;
    }
    let line: string;
    try {
      line = readFileSync(`/proc/${entry}/stat`, 'utf8');
    } catch {
      // The process exited between readdir and read.
      continue;
    }
    const stat = parseProcStat(line.trimEnd());
    if (stat !== null) {
      stats.push(stat);
    }
  }
  return stats;
};

/** Linux sampler: one `/proc` walk. Null when `pid` is no longer alive. */
export const linuxTreeCpuMs = (pid: number): number | null =>
  treeCpuMsFromStats(pid, readLinuxProcStats());

const psTimePattern = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/u;

/** `ps -o cputime` prints `[[dd-]hh:]mm:ss[.cc]`; returns milliseconds. */
export const parsePsCpuTime = (text: string): number | null => {
  const match = psTimePattern.exec(text.trim());
  if (match === null) {
    return null;
  }
  const [, days, hours, minutes, seconds] = match;
  const total =
    Number(days ?? 0) * 86_400 +
    Number(hours ?? 0) * 3_600 +
    Number(minutes) * 60 +
    Number(seconds);
  return Number.isFinite(total) ? Math.round(total * 1_000) : null;
};

/** Parses `ps -o pid=,ppid=,cputime= -ax` output into the sampler's table. */
export const parsePsTree = (output: string): readonly ProcessStat[] => {
  const stats: ProcessStat[] = [];
  for (const line of output.split('\n')) {
    const fields = line.trim().split(/\s+/u);
    if (fields.length < 3) {
      continue;
    }
    const pid = Number(fields[0]);
    const ppid = Number(fields[1]);
    const cpuMs = parsePsCpuTime(fields[2] ?? '');
    if (!Number.isInteger(pid) || !Number.isInteger(ppid) || cpuMs === null) {
      continue;
    }
    stats.push({ pid, ppid, cpuTicks: Math.round(cpuMs / msPerTick) });
  }
  return stats;
};

/** macOS sampler: one `ps` per pass. Null when `ps` fails or `pid` is gone. */
export const darwinTreeCpuMs = (pid: number): Effect.Effect<number | null> =>
  Effect.promise(
    () =>
      new Promise<number | null>((resolve) => {
        execFile(
          'ps',
          ['-o', 'pid=,ppid=,cputime=', '-ax'],
          { maxBuffer: 16 * 1024 * 1024 },
          (error, stdout) => {
            resolve(error === null ? treeCpuMsFromStats(pid, parsePsTree(stdout)) : null);
          },
        );
      }),
  );

export type TreeCpuSampler = (pid: number) => Effect.Effect<number | null>;

/** Platform sampler; other platforms return null, which disables detection. */
export const platformTreeCpuSampler = (
  platform: NodeJS.Platform = process.platform,
): TreeCpuSampler => {
  switch (platform) {
    case 'linux':
      return (pid) => Effect.sync(() => linuxTreeCpuMs(pid));
    case 'darwin':
      return darwinTreeCpuMs;
    default:
      return () => Effect.succeed(null);
  }
};

export const defaultStallSampleIntervalMs = 30_000;

/**
 * The monitor's view of the outside world, injectable so tests drive the
 * clock, the CPU readings, and each sampling pass without waiting ten
 * minutes. The default is the platform sampler on a 30 s cadence.
 */
export interface StallProbeShape {
  readonly sampleTreeCpuMs: TreeCpuSampler;
  readonly now: () => number;
  /** Resolves when the next sampling pass should run. */
  readonly nextSample: Effect.Effect<void>;
}

export const StallProbe: Context.Reference<StallProbeShape> = Context.Reference<StallProbeShape>(
  'cargo-hauler/StallProbe',
  {
    defaultValue: () => ({
      nextSample: Effect.sleep(`${defaultStallSampleIntervalMs} millis`),
      now: () => Date.now(),
      sampleTreeCpuMs: platformTreeCpuSampler(),
    }),
  },
);

/** Last CPU reading for a leader and when the reading last changed. */
export interface CpuTrack {
  readonly cpuMs: number;
  readonly progressAtMs: number;
}

export interface StallThresholds {
  readonly estimateFactor: number;
  readonly idleMs: number;
}

export interface StallSampleInput {
  readonly track: CpuTrack | undefined;
  readonly previous: StallReport | null;
  readonly cpuMs: number;
  readonly nowMs: number;
  readonly startedAtMs: number;
  readonly lastOutputAtMs: number | null;
  readonly estimateMs: number;
}

/**
 * One sampling step. Any change in tree CPU time counts as progress — a
 * drop means a child exited, which is activity too. A stall keeps its
 * original `since` across samples while the idle window keeps growing.
 */
export const evaluateStall = (
  input: StallSampleInput,
  thresholds: StallThresholds,
): { readonly track: CpuTrack; readonly stall: StallReport | null } => {
  if (input.track === undefined || input.track.cpuMs !== input.cpuMs) {
    return { track: { cpuMs: input.cpuMs, progressAtMs: input.nowMs }, stall: null };
  }
  const idleMs = Math.max(0, input.nowMs - input.track.progressAtMs);
  const elapsedMs = Math.max(0, input.nowMs - input.startedAtMs);
  const quietMs = Math.max(0, input.nowMs - (input.lastOutputAtMs ?? input.startedAtMs));
  const stalled =
    elapsedMs > thresholds.estimateFactor * input.estimateMs &&
    idleMs >= thresholds.idleMs &&
    quietMs >= thresholds.idleMs;
  return {
    track: input.track,
    stall: stalled
      ? { since: input.previous?.since ?? input.nowMs, idleMs, cpuMs: input.cpuMs }
      : null,
  };
};

export const stalledKillReason = (idleMs: number): string =>
  `stalled: no CPU for ${Math.floor(idleMs / 60_000)}m after owner disconnected; killed automatically`;

export interface StallMonitorDeps {
  readonly config: Pick<DaemonConfigShape, 'stallEstimateFactor' | 'stallIdleMs' | 'stallAutoKill'>;
  readonly directory: TicketDirectory;
  readonly probe: StallProbeShape;
  /** The broker's kill path, so riders settle exactly as for a manual kill. */
  readonly kill: (ticket: string, reason: string) => Effect.Effect<boolean>;
}

interface MonitorTrack extends CpuTrack {
  readonly autoKillRequested: boolean;
}

/**
 * Daemon-wide sampling loop over every running leader in the directory.
 * Flags stalls on the job; kills only when the owner is gone and auto-kill
 * is on, once per job. A sampler that returns null (process gone, platform
 * unsupported) clears the verdict rather than inventing one.
 */
export const makeStallMonitor = (deps: StallMonitorDeps): Effect.Effect<never> => {
  const { config, directory, probe, kill } = deps;
  const idleMs = config.stallIdleMs;
  if (idleMs === null) {
    return Effect.never;
  }
  const thresholds: StallThresholds = { estimateFactor: config.stallEstimateFactor, idleMs };
  const tracks = new WeakMap<Job, MonitorTrack>();

  const runningLeaders = (): readonly Job[] => {
    const jobs: Job[] = [];
    for (const entry of directory.entries()) {
      if (
        entry.kind === 'leader' &&
        entry.job.pid !== null &&
        entry.job.startedAtMs !== null &&
        Ref.getUnsafe(entry.job.state) === 'running'
      ) {
        jobs.push(entry.job);
      }
    }
    return jobs;
  };

  const sampleLeader = (job: Job, nowMs: number): Effect.Effect<void> =>
    Effect.gen(function* () {
      if (job.pid === null || job.startedAtMs === null) {
        return;
      }
      const cpuMs = yield* probe.sampleTreeCpuMs(job.pid);
      if (cpuMs === null) {
        tracks.delete(job);
        job.stall = null;
        return;
      }
      const track = tracks.get(job);
      const verdict = evaluateStall(
        {
          cpuMs,
          estimateMs: job.estimateMs,
          lastOutputAtMs: job.lastOutputAtMs,
          nowMs,
          previous: job.stall,
          startedAtMs: job.startedAtMs,
          track,
        },
        thresholds,
      );
      const autoKillRequested = track?.autoKillRequested === true;
      tracks.set(job, { ...verdict.track, autoKillRequested });
      const previous = job.stall;
      job.stall = verdict.stall;
      if (verdict.stall === null) {
        return;
      }
      if (previous === null) {
        yield* Effect.logWarning(
          `ticket ${job.ticket} looks stalled: no CPU for ${Math.floor(verdict.stall.idleMs / 60_000)}m and no output, ${Math.floor((nowMs - job.startedAtMs) / 60_000)}m elapsed against a ~${Math.floor(job.estimateMs / 60_000)}m estimate${job.ownerGone ? ' (owner disconnected)' : ''}`,
        );
      }
      if (!config.stallAutoKill || !job.ownerGone || autoKillRequested) {
        return;
      }
      tracks.set(job, { ...verdict.track, autoKillRequested: true });
      const reason = stalledKillReason(verdict.stall.idleMs);
      yield* Effect.logWarning(`ticket ${job.ticket} ${reason}`);
      yield* kill(job.ticket, reason);
    });

  const pass = Effect.gen(function* () {
    const nowMs = probe.now();
    yield* Effect.forEach(runningLeaders(), (job) => sampleLeader(job, nowMs), {
      discard: true,
    });
  });

  return Effect.forever(
    probe.nextSample.pipe(
      Effect.andThen(pass),
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterruptsOnly(cause),
        (cause) => Effect.logError(`stall monitor pass failed: ${Cause.pretty(cause)}`),
      ),
    ),
  );
};
