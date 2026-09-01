import { describe, expect, it } from '@rstest/core';

import { cpuSomeAvg10 } from '../src/daemon/pressure.js';
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

  it('does not mistake the full line for the some line', () => {
    expect(cpuSomeAvg10(() => 'full avg10=99.9 avg60=0 avg300=0 total=0\n')).toBeNull();
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
