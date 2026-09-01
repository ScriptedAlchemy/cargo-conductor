import { readFileSync } from 'node:fs';

/**
 * Disk/IO pressure for the status report, sampled from Linux /proc deltas.
 *
 * Loadavg alone hides the classic rust-build stall: a machine at modest load
 * whose cargo processes are all blocked on disk shows high iowait and a busy
 * device, not a hot CPU. Two honest numbers cover that tell:
 *
 * - iowait share of total CPU time between consecutive samples, from the
 *   aggregate `cpu` line of `/proc/stat`;
 * - per-device busy share (io_ticks delta over wall time) for the devices
 *   that back the hauler state dir and the in-flight target dirs,
 *   resolved through `/proc/self/mountinfo` → `/proc/diskstats`. No device
 *   path is ever hardcoded.
 *
 * Both need a previous sample to be honest, so the first report after daemon
 * start omits them, as does any platform where /proc is unavailable
 * (macOS, Windows): no number is better than a fabricated one.
 */

export type ReadFile = (path: string) => string;

const defaultRead: ReadFile = (path) => readFileSync(path, 'utf8');

const procStatPath = '/proc/stat';
const mountInfoPath = '/proc/self/mountinfo';
const diskStatsPath = '/proc/diskstats';

export interface CpuTicks {
  readonly iowaitTicks: number;
  readonly totalTicks: number;
}

/** Aggregate `cpu` line of /proc/stat: iowait and the sum of all fields. */
export const parseProcStatCpu = (content: string): CpuTicks | null => {
  const line = content.split('\n').find((candidate) => /^cpu\s/u.test(candidate));
  if (line === undefined) {
    return null;
  }
  const fields = line.split(/\s+/u).slice(1).map(Number);
  // user nice system idle iowait irq softirq steal [guest guest_nice]
  if (fields.length < 5 || fields.some((value) => !Number.isFinite(value))) {
    return null;
  }
  return {
    iowaitTicks: fields[4],
    totalTicks: fields.reduce((sum, value) => sum + value, 0),
  };
};

/** iowait share (0–100) of the CPU time elapsed between two samples. */
export const ioWaitPercentBetween = (previous: CpuTicks, current: CpuTicks): number | null => {
  const totalDelta = current.totalTicks - previous.totalTicks;
  if (totalDelta <= 0) {
    return null;
  }
  const iowaitDelta = current.iowaitTicks - previous.iowaitTicks;
  return Math.min(100, Math.max(0, (iowaitDelta / totalDelta) * 100));
};

export interface MountEntry {
  readonly mountPoint: string;
  /** `major:minor` of the backing device, as printed in mountinfo field 3. */
  readonly majorMinor: string;
}

// Mountinfo escapes space, tab, newline, and backslash as 3-digit octal.
const unescapeMountPath = (raw: string): string =>
  raw.replaceAll(/\\(\d{3})/gu, (_, octal: string) =>
    String.fromCharCode(Number.parseInt(octal, 8)),
  );

/** Mount points with their backing `major:minor`, from /proc/self/mountinfo. */
export const parseMountInfo = (content: string): readonly MountEntry[] => {
  const entries: MountEntry[] = [];
  for (const line of content.split('\n')) {
    // mountId parentId major:minor root mountPoint options ... - fstype source superOptions
    const fields = line.split(' ');
    if (fields.length < 5 || !/^\d+:\d+$/u.test(fields[2])) {
      continue;
    }
    entries.push({ majorMinor: fields[2], mountPoint: unescapeMountPath(fields[4]) });
  }
  return entries;
};

/** The `major:minor` backing a path: its longest-prefix mount point wins. */
export const deviceForPath = (
  path: string,
  mounts: readonly MountEntry[],
): string | null => {
  let best: MountEntry | null = null;
  for (const mount of mounts) {
    const covers =
      mount.mountPoint === '/' ||
      path === mount.mountPoint ||
      path.startsWith(`${mount.mountPoint}/`);
    if (covers && (best === null || mount.mountPoint.length > best.mountPoint.length)) {
      best = mount;
    }
  }
  return best?.majorMinor ?? null;
};

export interface DiskCounters {
  readonly name: string;
  /** Milliseconds the device spent with I/O in flight (diskstats io_ticks). */
  readonly ioTicksMs: number;
}

/** Per-device io_ticks keyed by `major:minor`, from /proc/diskstats. */
export const parseDiskStats = (content: string): ReadonlyMap<string, DiskCounters> => {
  const devices = new Map<string, DiskCounters>();
  for (const line of content.split('\n')) {
    const fields = line.trim().split(/\s+/u);
    // major minor name reads(4) ... writes(4) inflight io_ticks weighted...
    if (fields.length < 13) {
      continue;
    }
    const ioTicksMs = Number(fields[12]);
    if (!Number.isFinite(ioTicksMs)) {
      continue;
    }
    devices.set(`${fields[0]}:${fields[1]}`, { ioTicksMs, name: fields[2] });
  }
  return devices;
};

export interface DiskUtilSample {
  readonly device: string;
  readonly utilPercent: number;
}

export interface SystemIoSample {
  /** iowait share of CPU time since the previous sample, or null if unknown. */
  readonly ioWaitPercent: number | null;
  /** Busy share of each watched device since the previous sample. */
  readonly disks: readonly DiskUtilSample[];
}

export interface SystemIoSampler {
  /**
   * Sample against the previous call. `paths` name the directories whose
   * backing devices matter right now (state dir, in-flight target dirs).
   * Returns null before a delta exists or where /proc is unavailable.
   */
  readonly sample: (paths: readonly string[], nowMs?: number) => SystemIoSample | null;
}

interface SamplerState {
  readonly atMs: number;
  readonly cpu: CpuTicks | null;
  readonly disks: ReadonlyMap<string, DiskCounters>;
}

/** Below this spacing a repeat sample reuses the last delta instead of degrading it. */
export const minSampleSpacingMs = 1_000;

export const createSystemIoSampler = (read: ReadFile = defaultRead): SystemIoSampler => {
  let previous: SamplerState | undefined;
  let lastSample: SystemIoSample | null = null;

  const readState = (nowMs: number): SamplerState | null => {
    let statContent: string;
    try {
      statContent = read(procStatPath);
    } catch {
      return null;
    }
    let diskContent = '';
    try {
      diskContent = read(diskStatsPath);
    } catch {
      // CPU iowait can still be honest without per-device counters.
    }
    return {
      atMs: nowMs,
      cpu: parseProcStatCpu(statContent),
      disks: parseDiskStats(diskContent),
    };
  };

  const sample = (paths: readonly string[], nowMs = Date.now()): SystemIoSample | null => {
    const current = readState(nowMs);
    if (current === null) {
      return null;
    }
    if (previous === undefined) {
      previous = current;
      return null;
    }
    const elapsedMs = current.atMs - previous.atMs;
    if (elapsedMs < minSampleSpacingMs) {
      return lastSample;
    }

    let mounts: readonly MountEntry[] = [];
    try {
      mounts = parseMountInfo(read(mountInfoPath));
    } catch {
      // Devices degrade to none; iowait stays honest.
    }
    const watched = new Set<string>();
    for (const path of paths) {
      if (path.length === 0) {
        continue;
      }
      const device = deviceForPath(path, mounts);
      if (device !== null) {
        watched.add(device);
      }
    }

    const disks: DiskUtilSample[] = [];
    for (const majorMinor of watched) {
      const before = previous.disks.get(majorMinor);
      const after = current.disks.get(majorMinor);
      // Virtual filesystems (major 0: btrfs, overlay, tmpfs) have no
      // diskstats row; they are omitted rather than guessed at.
      if (before === undefined || after === undefined) {
        continue;
      }
      const busyMs = after.ioTicksMs - before.ioTicksMs;
      disks.push({
        device: after.name,
        utilPercent: Math.min(100, Math.max(0, (busyMs / elapsedMs) * 100)),
      });
    }
    disks.sort((left, right) => right.utilPercent - left.utilPercent || left.device.localeCompare(right.device));

    const ioWaitPercent =
      previous.cpu !== null && current.cpu !== null
        ? ioWaitPercentBetween(previous.cpu, current.cpu)
        : null;

    previous = current;
    lastSample = { disks, ioWaitPercent };
    return lastSample;
  };

  return { sample };
};
