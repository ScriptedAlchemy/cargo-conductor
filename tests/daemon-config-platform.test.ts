import { describe, expect, it } from 'effect-rstest';

import { resolveDaemonConfig } from '../src/daemon/config.js';

describe('daemon config platform posture', () => {
  it('resolves a \\\\.\\pipe\\ named pipe on win32 instead of a filesystem .sock path', () => {
    const config = resolveDaemonConfig({ CARGO_HAULER_STATE_DIR: 'C:\\cc-test' }, 'win32');
    expect(config.socketPath.startsWith('\\\\.\\pipe\\cargo-hauler-')).toBe(true);
    expect(config.socketPath.endsWith('.sock')).toBe(false);
  });

  it('resolves normally on POSIX platforms', () => {
    for (const platform of ['linux', 'darwin'] as const) {
      const config = resolveDaemonConfig({ CARGO_HAULER_STATE_DIR: '/tmp/cc-test' }, platform);
      expect(config.socketPath.endsWith('daemon.sock')).toBe(true);
    }
  });

  it('uses a brief configurable batching window for near-simultaneous requests', () => {
    expect(resolveDaemonConfig({}).batchWindowMs).toBe(150);
    expect(resolveDaemonConfig({ CARGO_HAULER_BATCH_WINDOW_MS: '0' }).batchWindowMs).toBe(0);
    expect(resolveDaemonConfig({ CARGO_HAULER_BATCH_WINDOW_MS: '275' }).batchWindowMs).toBe(275);
  });

  it('enables machine-tuned memory defaults only where signals exist', () => {
    expect(resolveDaemonConfig({}, 'linux')).toMatchObject({
      memAvailableMinBytes: 8 * 1024 ** 3,
      memPressureHardThreshold: 20,
      memPressureLevelThreshold: null,
      memPressureSoftThreshold: 10,
    });
    expect(resolveDaemonConfig({}, 'darwin')).toMatchObject({
      memAvailableMinBytes: null,
      memPressureHardThreshold: null,
      memPressureLevelThreshold: 2,
      memPressureSoftThreshold: null,
    });
    expect(resolveDaemonConfig({}, 'win32')).toMatchObject({
      memAvailableMinBytes: null,
      memPressureHardThreshold: null,
      memPressureLevelThreshold: null,
      memPressureSoftThreshold: null,
    });
  });

  it('parses memory overrides and treats explicit zero as disabled', () => {
    expect(
      resolveDaemonConfig(
        {
          CARGO_HAULER_MEM_AVAILABLE_MIN_GB: '12.5',
          CARGO_HAULER_MEM_PRESSURE_HARD: '30',
          CARGO_HAULER_MEM_PRESSURE_SOFT: '15',
        },
        'linux',
      ),
    ).toMatchObject({
      memAvailableMinBytes: 12.5 * 1024 ** 3,
      memPressureHardThreshold: 30,
      memPressureSoftThreshold: 15,
    });
    expect(
      resolveDaemonConfig(
        {
          CARGO_HAULER_MEM_AVAILABLE_MIN_GB: '0',
          CARGO_HAULER_MEM_PRESSURE_HARD: '0',
          CARGO_HAULER_MEM_PRESSURE_SOFT: '0',
        },
        'linux',
      ),
    ).toMatchObject({
      memAvailableMinBytes: null,
      memPressureHardThreshold: null,
      memPressureSoftThreshold: null,
    });
    expect(
      resolveDaemonConfig({ CARGO_HAULER_MEM_PRESSURE_LEVEL: '4' }, 'darwin')
        .memPressureLevelThreshold,
    ).toBe(4);
    expect(
      resolveDaemonConfig({ CARGO_HAULER_MEM_PRESSURE_LEVEL: '0' }, 'darwin')
        .memPressureLevelThreshold,
    ).toBeNull();
  });

  it('caps heavy leaders under low MemAvailable only where the signal exists', () => {
    expect(resolveDaemonConfig({}, 'linux')).toMatchObject({
      heavyMaxConcurrent: 1,
      heavyMemAvailableBytes: 16 * 1024 ** 3,
    });
    expect(resolveDaemonConfig({}, 'darwin').heavyMemAvailableBytes).toBeNull();
    expect(resolveDaemonConfig({}, 'win32').heavyMemAvailableBytes).toBeNull();
    expect(
      resolveDaemonConfig(
        { CARGO_HAULER_HEAVY_MAX_CONCURRENT: '2', CARGO_HAULER_HEAVY_MEM_AVAILABLE_GB: '24' },
        'linux',
      ),
    ).toMatchObject({ heavyMaxConcurrent: 2, heavyMemAvailableBytes: 24 * 1024 ** 3 });
    for (const disabled of ['0', 'off']) {
      expect(
        resolveDaemonConfig({ CARGO_HAULER_HEAVY_MEM_AVAILABLE_GB: disabled }, 'linux')
          .heavyMemAvailableBytes,
      ).toBeNull();
    }
    expect(
      resolveDaemonConfig({ CARGO_HAULER_HEAVY_MAX_CONCURRENT: '0' }, 'linux').heavyMaxConcurrent,
    ).toBe(1);
  });

  it('retains legacy tuning aliases because they cannot change state identity', () => {
    const legacy = resolveDaemonConfig({
      CARGO_CONDUCTOR_BATCH: '0',
      CARGO_CONDUCTOR_BATCH_WINDOW_MS: '275',
      CARGO_CONDUCTOR_CPU_PRESSURE_THRESHOLD: '0',
      CARGO_CONDUCTOR_JOBS_GRANT: '7',
      CARGO_CONDUCTOR_LOAD_MIN: '3',
      CARGO_CONDUCTOR_LOAD_THRESHOLD: '1.5',
      CARGO_CONDUCTOR_MAX_CONCURRENT: '4',
      CARGO_CONDUCTOR_REPLAY_BUFFER_BYTES: '2048',
    });
    expect(legacy).toMatchObject({
      batchEnabled: false,
      batchWindowMs: 275,
      cpuStallThreshold: null,
      jobsGrant: 7,
      loadMinConcurrent: 3,
      loadThresholdPerCore: 1.5,
      maxConcurrent: 4,
      replayBufferBytes: 2048,
    });

    const preferred = resolveDaemonConfig({
      CARGO_CONDUCTOR_MAX_CONCURRENT: '4',
      CARGO_HAULER_MAX_CONCURRENT: '6',
    });
    expect(preferred.maxConcurrent).toBe(6);
  });
});
