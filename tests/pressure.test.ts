import { describe, expect, it } from '@rstest/core';

import {
  cpuSomeAvg10,
  memoryAvailableBytes,
  memoryPressureLevel,
  memoryPsi,
} from '../src/daemon/pressure.js';
import { shouldDeferAdmission } from '../src/daemon/scheduler.js';

const psiSample = `some avg10=12.34 avg60=5.67 avg300=1.89 total=123456789
full avg10=0.42 avg60=0.10 avg300=0.02 total=9876543
`;

describe('cpuSomeAvg10', () => {
  it('parses the some avg10 percentage from /proc/pressure/cpu', () => {
    expect(cpuSomeAvg10(() => psiSample)).toBe(12.34);
  });

  it('reports null where PSI is unavailable', () => {
    expect(
      cpuSomeAvg10(() => {
        throw new Error('ENOENT');
      }),
    ).toBeNull();
    expect(cpuSomeAvg10(() => 'not psi output')).toBeNull();
  });

  it('reports null on restricted /proc (EACCES) instead of throwing', () => {
    const eacces = Object.assign(new Error('EACCES: permission denied'), {
      code: 'EACCES',
      errno: -13,
    });
    expect(
      cpuSomeAvg10(() => {
        throw eacces;
      }),
    ).toBeNull();
  });

  it('does not mistake the full line for the some line', () => {
    expect(cpuSomeAvg10(() => 'full avg10=99.9 avg60=0 avg300=0 total=0\n')).toBeNull();
  });
});

describe('memoryPsi', () => {
  const memorySample = `some avg10=1.25 avg60=2.63 avg300=3.50 total=123
full avg10=1.24 avg60=2.50 avg300=3.40 total=456
`;

  it('parses some/full avg10 and full avg60 from Linux PSI', () => {
    expect(memoryPsi({ platform: 'linux', read: () => memorySample })).toEqual({
      fullAvg10: 1.24,
      fullAvg60: 2.5,
      someAvg10: 1.25,
    });
  });

  it('reports null for absent, restricted, malformed, and non-Linux signals', () => {
    for (const code of ['ENOENT', 'EACCES']) {
      expect(
        memoryPsi({
          platform: 'linux',
          read: () => {
            throw Object.assign(new Error(code), { code });
          },
        }),
      ).toBeNull();
    }
    expect(memoryPsi({ platform: 'linux', read: () => 'some avg10=1.0\n' })).toBeNull();
    expect(memoryPsi({ platform: 'darwin', read: () => memorySample })).toBeNull();
  });
});

describe('memoryAvailableBytes', () => {
  it('parses MemAvailable from Linux meminfo as bytes', () => {
    expect(
      memoryAvailableBytes({
        platform: 'linux',
        read: () => 'MemTotal:       65536 kB\nMemAvailable:   12345 kB\n',
      }),
    ).toBe(12_345 * 1024);
  });

  it('reports null when MemAvailable or the platform signal is unavailable', () => {
    expect(memoryAvailableBytes({ platform: 'linux', read: () => 'MemTotal: 65536 kB\n' })).toBeNull();
    expect(
      memoryAvailableBytes({
        platform: 'linux',
        read: () => {
          throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
        },
      }),
    ).toBeNull();
    expect(memoryAvailableBytes({ platform: 'win32', read: () => 'MemAvailable: 1 kB\n' })).toBeNull();
  });
});

describe('memoryPressureLevel', () => {
  it('strictly accepts the documented macOS levels', () => {
    for (const level of [1, 2, 4] as const) {
      expect(
        memoryPressureLevel({
          execFile: () => `${level}\n`,
          nowMs: () => level * 10_000,
          platform: 'darwin',
        }),
      ).toBe(level);
    }
  });

  it('reports null for garbage, timeout errors, and non-macOS platforms', () => {
    expect(
      memoryPressureLevel({
        execFile: () => '3\n',
        nowMs: () => 100_000,
        platform: 'darwin',
      }),
    ).toBeNull();
    expect(
      memoryPressureLevel({
        execFile: () => {
          throw Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' });
        },
        nowMs: () => 110_000,
        platform: 'darwin',
      }),
    ).toBeNull();
    expect(
      memoryPressureLevel({
        execFile: () => '4\n',
        nowMs: () => 120_000,
        platform: 'linux',
      }),
    ).toBeNull();
  });

  it('caches the sysctl result for two seconds', () => {
    let calls = 0;
    let nowMs = 200_000;
    const execFile = (): string => {
      calls += 1;
      return calls === 1 ? '2\n' : '4\n';
    };
    expect(memoryPressureLevel({ execFile, nowMs: () => nowMs, platform: 'darwin' })).toBe(2);
    nowMs += 1_999;
    expect(memoryPressureLevel({ execFile, nowMs: () => nowMs, platform: 'darwin' })).toBe(2);
    nowMs += 2;
    expect(memoryPressureLevel({ execFile, nowMs: () => nowMs, platform: 'darwin' })).toBe(4);
    expect(calls).toBe(2);
  });
});

describe('shouldDeferAdmission with cpu stall', () => {
  const base = {
    loadPerCore: 0.1,
    minConcurrent: 2,
    running: 3,
    thresholdPerCore: Number.POSITIVE_INFINITY,
  };

  it('defers on stall pressure even while loadavg is calm', () => {
    expect(
      shouldDeferAdmission({ ...base, cpuStallPercent: 80, cpuStallThreshold: 75 }),
    ).toBe(true);
    expect(
      shouldDeferAdmission({ ...base, cpuStallPercent: 40, cpuStallThreshold: 75 }),
    ).toBe(false);
  });

  it('never throttles below the concurrency floor', () => {
    expect(
      shouldDeferAdmission({
        ...base,
        cpuStallPercent: 99,
        cpuStallThreshold: 75,
        running: 1,
      }),
    ).toBe(false);
  });

  it('ignores the PSI arm when the platform or config disables it', () => {
    expect(shouldDeferAdmission({ ...base, cpuStallPercent: null, cpuStallThreshold: 75 })).toBe(
      false,
    );
    expect(shouldDeferAdmission({ ...base, cpuStallPercent: 99, cpuStallThreshold: null })).toBe(
      false,
    );
    expect(shouldDeferAdmission(base)).toBe(false);
  });

  it('keeps the loadavg arm authoritative when it trips first', () => {
    expect(
      shouldDeferAdmission({
        cpuStallPercent: 0,
        cpuStallThreshold: 75,
        loadPerCore: 3,
        minConcurrent: 2,
        running: 3,
        thresholdPerCore: 1.5,
      }),
    ).toBe(true);
  });
});
