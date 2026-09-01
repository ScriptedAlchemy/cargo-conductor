import { describe, expect, it } from '@rstest/core';

import {
  createSystemIoSampler,
  deviceForPath,
  ioWaitPercentBetween,
  minSampleSpacingMs,
  parseDiskStats,
  parseMountInfo,
  parseProcStatCpu,
} from '../src/daemon/disk-stats.js';

const statAt = (iowait: number, busy: number): string =>
  // user nice system idle iowait irq softirq steal guest guest_nice
  `cpu  ${busy} 0 0 8000 ${iowait} 0 0 0 0 0\ncpu0 1 0 0 1 0 0 0 0 0 0\n`;

const mountInfo = [
  // mountId parentId major:minor root mountPoint options - fstype source superOptions
  '22 1 259:1 / / rw,relatime - ext4 /dev/nvme0n1p1 rw',
  '95 22 8:16 / /scratch rw,noatime - ext4 /dev/sdb rw',
  '96 22 8:16 / /scratch/with\\040space rw - ext4 /dev/sdb rw',
  '97 22 0:41 / /virtual rw - btrfs /dev/vg/sub rw',
].join('\n');

const diskStats = (rootTicks: number, scratchTicks: number): string =>
  [
    ` 259       1 nvme0n1p1 100 0 800 40 200 0 1600 90 0 ${rootTicks} 130`,
    `   8      16 sdb 50 0 400 20 100 0 800 45 0 ${scratchTicks} 65`,
  ].join('\n');

describe('parseProcStatCpu', () => {
  it('reads iowait and the total from the aggregate cpu line only', () => {
    const ticks = parseProcStatCpu(statAt(250, 1_000));
    expect(ticks).toEqual({ iowaitTicks: 250, totalTicks: 9_250 });
  });

  it('returns null for content without an aggregate cpu line', () => {
    expect(parseProcStatCpu('intr 12345\nctxt 999\n')).toBeNull();
  });
});

describe('ioWaitPercentBetween', () => {
  it('reports the iowait share of elapsed CPU time', () => {
    const before = { iowaitTicks: 100, totalTicks: 10_000 };
    const after = { iowaitTicks: 350, totalTicks: 11_000 };
    expect(ioWaitPercentBetween(before, after)).toBe(25);
  });

  it('declines to report on a zero or negative delta', () => {
    const sample = { iowaitTicks: 1, totalTicks: 100 };
    expect(ioWaitPercentBetween(sample, sample)).toBeNull();
  });
});

describe('mountinfo device resolution (no hardcoded mount points)', () => {
  const mounts = parseMountInfo(mountInfo);

  it('parses mount points with their backing major:minor', () => {
    expect(mounts).toContainEqual({ majorMinor: '259:1', mountPoint: '/' });
    expect(mounts).toContainEqual({ majorMinor: '8:16', mountPoint: '/scratch' });
  });

  it('decodes octal escapes in mount points', () => {
    expect(mounts).toContainEqual({ majorMinor: '8:16', mountPoint: '/scratch/with space' });
  });

  it('resolves a path through its longest-prefix mount point', () => {
    expect(deviceForPath('/scratch/projects/app/target', mounts)).toBe('8:16');
    expect(deviceForPath('/home/alice/state', mounts)).toBe('259:1');
  });

  it('does not treat a mount point as a prefix of a sibling name', () => {
    // /scratchpad is on the root device, not on /scratch's.
    expect(deviceForPath('/scratchpad/x', mounts)).toBe('259:1');
  });

  it('returns null when no mount covers the path', () => {
    expect(deviceForPath('/x', [{ majorMinor: '8:1', mountPoint: '/data' }])).toBeNull();
  });
});

describe('parseDiskStats', () => {
  it('keys io_ticks milliseconds by major:minor', () => {
    const devices = parseDiskStats(diskStats(1_200, 4_500));
    expect(devices.get('259:1')).toEqual({ ioTicksMs: 1_200, name: 'nvme0n1p1' });
    expect(devices.get('8:16')).toEqual({ ioTicksMs: 4_500, name: 'sdb' });
  });
});

describe('createSystemIoSampler', () => {
  const makeRead =
    (files: { stat: string; disks: string }) =>
    (path: string): string => {
      switch (path) {
        case '/proc/stat':
          return files.stat;
        case '/proc/self/mountinfo':
          return mountInfo;
        case '/proc/diskstats':
          return files.disks;
        default:
          throw new Error(`unexpected read: ${path}`);
      }
    };

  it('omits the first sample: no delta means no honest number', () => {
    const files = { disks: diskStats(0, 0), stat: statAt(0, 1_000) };
    const sampler = createSystemIoSampler(makeRead(files));
    expect(sampler.sample(['/scratch/app/target'], 1_000)).toBeNull();
  });

  it('reports iowait and per-device busy share from /proc deltas', () => {
    const files = { disks: diskStats(0, 0), stat: statAt(0, 1_000) };
    const sampler = createSystemIoSampler(makeRead(files));
    expect(sampler.sample(['/scratch/app/target', '/home/alice/.cache/cc'], 1_000)).toBeNull();

    // 5s later: 400 of 1000 elapsed ticks were iowait; sdb was busy 3s of
    // 5s (60%), the root device 0.5s of 5s (10%).
    files.stat = statAt(400, 1_600);
    files.disks = diskStats(500, 3_000);
    const sample = sampler.sample(['/scratch/app/target', '/home/alice/.cache/cc'], 6_000);
    expect(sample?.ioWaitPercent).toBeCloseTo(40);
    expect(sample?.disks).toEqual([
      { device: 'sdb', utilPercent: 60 },
      { device: 'nvme0n1p1', utilPercent: 10 },
    ]);
  });

  it('omits devices without diskstats rows (virtual filesystems) instead of guessing', () => {
    const files = { disks: diskStats(0, 0), stat: statAt(0, 1_000) };
    const sampler = createSystemIoSampler(makeRead(files));
    sampler.sample(['/virtual/checkout'], 1_000);
    files.stat = statAt(100, 1_500);
    const sample = sampler.sample(['/virtual/checkout'], 6_000);
    expect(sample?.disks).toEqual([]);
    expect(sample?.ioWaitPercent).not.toBeNull();
  });

  it('returns null where /proc is unavailable (macOS, Windows)', () => {
    const sampler = createSystemIoSampler(() => {
      throw new Error('ENOENT');
    });
    expect(sampler.sample(['/anything'], 1_000)).toBeNull();
    expect(sampler.sample(['/anything'], 6_000)).toBeNull();
  });

  it('reuses the last delta instead of degrading it when polled too fast', () => {
    const files = { disks: diskStats(0, 0), stat: statAt(0, 1_000) };
    const sampler = createSystemIoSampler(makeRead(files));
    sampler.sample(['/scratch/x'], 1_000);
    files.stat = statAt(400, 1_600);
    files.disks = diskStats(0, 3_000);
    const settled = sampler.sample(['/scratch/x'], 6_000);
    expect(settled?.ioWaitPercent).toBeCloseTo(40);
    // A immediate re-poll must not produce a near-zero-elapsed delta.
    const rushed = sampler.sample(['/scratch/x'], 6_000 + minSampleSpacingMs - 1);
    expect(rushed).toBe(settled);
  });

  it('clamps counter anomalies to the honest 0..100 range', () => {
    const files = { disks: diskStats(0, 0), stat: statAt(0, 1_000) };
    const sampler = createSystemIoSampler(makeRead(files));
    sampler.sample(['/scratch/x'], 1_000);
    // io_ticks claims more busy time than the wall clock elapsed.
    files.stat = statAt(2_000, 3_000);
    files.disks = diskStats(0, 99_000);
    const sample = sampler.sample(['/scratch/x'], 2_500);
    expect(sample?.disks).toEqual([{ device: 'sdb', utilPercent: 100 }]);
  });
});
