import { describe, expect, it } from 'effect-rstest';

import {
  defaultMaxConcurrentFor,
  resolveDaemonConfig,
  resolveDaemonConfigWithWarnings,
} from '../src/daemon/config.js';

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

  it('warns and keeps the default when a numeric override is not a valid number', () => {
    const { config, warnings } = resolveDaemonConfigWithWarnings(
      {
        CARGO_HAULER_CPU_PRESSURE_THRESHOLD: 'abc',
        CARGO_HAULER_MAX_CONCURRENT: '0',
        CARGO_HAULER_MEM_AVAILABLE_MIN_GB: 'abc',
        CARGO_HAULER_MEM_PRESSURE_HARD: 'abc',
        CARGO_HAULER_MEM_PRESSURE_SOFT: 'abc',
        CARGO_HAULER_LOAD_MIN: '1.5',
      },
      'linux',
      8,
    );
    expect(config).toMatchObject({
      cpuStallThreshold: 75,
      loadMinConcurrent: 2,
      maxConcurrent: 5,
      memAvailableMinBytes: 8 * 1024 ** 3,
      memPressureHardThreshold: 20,
      memPressureSoftThreshold: 10,
    });
    expect(warnings).toHaveLength(6);
    for (const name of [
      'CARGO_HAULER_CPU_PRESSURE_THRESHOLD',
      'CARGO_HAULER_MAX_CONCURRENT',
      'CARGO_HAULER_MEM_AVAILABLE_MIN_GB',
      'CARGO_HAULER_MEM_PRESSURE_HARD',
      'CARGO_HAULER_MEM_PRESSURE_SOFT',
      'CARGO_HAULER_LOAD_MIN',
    ]) {
      expect(warnings.some((warning) => warning.includes(name))).toBe(true);
    }
  });

  it('routes warnings to the supplied sink and stays silent for valid input', () => {
    const seen: string[] = [];
    resolveDaemonConfig({ CARGO_HAULER_MAX_CONCURRENT: 'many' }, 'linux', (warning) =>
      seen.push(warning),
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('CARGO_HAULER_MAX_CONCURRENT');
    expect(
      resolveDaemonConfigWithWarnings({ CARGO_HAULER_MAX_CONCURRENT: '3' }, 'linux').warnings,
    ).toEqual([]);
  });

  it('disables pressure arms with 0 or off without warning', () => {
    const { config, warnings } = resolveDaemonConfigWithWarnings(
      {
        CARGO_HAULER_CPU_PRESSURE_THRESHOLD: 'off',
        CARGO_HAULER_MEM_AVAILABLE_MIN_GB: 'off',
        CARGO_HAULER_MEM_PRESSURE_HARD: '0',
        CARGO_HAULER_MEM_PRESSURE_SOFT: 'off',
        CARGO_HAULER_MEM_PRESSURE_LEVEL: 'off',
      },
      'linux',
    );
    expect(config).toMatchObject({
      cpuStallThreshold: null,
      memAvailableMinBytes: null,
      memPressureHardThreshold: null,
      memPressureSoftThreshold: null,
    });
    expect(warnings).toEqual([]);
    expect(
      resolveDaemonConfigWithWarnings({ CARGO_HAULER_MEM_PRESSURE_LEVEL: 'off' }, 'darwin').config
        .memPressureLevelThreshold,
    ).toBeNull();
  });

  it('warns and restores the default pair when soft memory pressure is not below hard', () => {
    const inverted = resolveDaemonConfigWithWarnings(
      { CARGO_HAULER_MEM_PRESSURE_HARD: '10', CARGO_HAULER_MEM_PRESSURE_SOFT: '30' },
      'linux',
    );
    expect(inverted.config).toMatchObject({
      memPressureHardThreshold: 20,
      memPressureSoftThreshold: 10,
    });
    expect(inverted.warnings).toHaveLength(1);
    expect(inverted.warnings[0]).toContain('CARGO_HAULER_MEM_PRESSURE_SOFT');
    expect(inverted.warnings[0]).toContain('CARGO_HAULER_MEM_PRESSURE_HARD');

    // Lowering hard below the default soft trips the same check.
    const hardOnly = resolveDaemonConfigWithWarnings(
      { CARGO_HAULER_MEM_PRESSURE_HARD: '5' },
      'linux',
    );
    expect(hardOnly.config).toMatchObject({
      memPressureHardThreshold: 20,
      memPressureSoftThreshold: 10,
    });
    expect(hardOnly.warnings).toHaveLength(1);

    // Disabling one arm leaves nothing to compare.
    const softOff = resolveDaemonConfigWithWarnings(
      { CARGO_HAULER_MEM_PRESSURE_HARD: '5', CARGO_HAULER_MEM_PRESSURE_SOFT: '0' },
      'linux',
    );
    expect(softOff.config).toMatchObject({
      memPressureHardThreshold: 5,
      memPressureSoftThreshold: null,
    });
    expect(softOff.warnings).toEqual([]);
  });

  it('warns and keeps a valid macOS pressure level when the override is not 2 or 4', () => {
    const { config, warnings } = resolveDaemonConfigWithWarnings(
      { CARGO_HAULER_MEM_PRESSURE_LEVEL: '3' },
      'darwin',
    );
    expect(config.memPressureLevelThreshold).toBe(2);
    expect(warnings).toHaveLength(1);
  });

  it('accepts the usual false spellings for CARGO_HAULER_BATCH', () => {
    for (const disabled of ['0', 'false', 'off', 'no', 'FALSE', 'Off']) {
      expect(resolveDaemonConfigWithWarnings({ CARGO_HAULER_BATCH: disabled })).toMatchObject({
        config: { batchEnabled: false },
        warnings: [],
      });
    }
    for (const enabled of ['1', 'true', 'on', 'yes']) {
      expect(resolveDaemonConfigWithWarnings({ CARGO_HAULER_BATCH: enabled })).toMatchObject({
        config: { batchEnabled: true },
        warnings: [],
      });
    }
    const garbage = resolveDaemonConfigWithWarnings({ CARGO_HAULER_BATCH: 'maybe' });
    expect(garbage.config.batchEnabled).toBe(true);
    expect(garbage.warnings).toHaveLength(1);
    expect(garbage.warnings[0]).toContain('CARGO_HAULER_BATCH');
  });

  it('reads ledger retention limits with 0 disabling each', () => {
    expect(resolveDaemonConfig({})).toMatchObject({
      ledgerMaxRows: 50_000,
      ledgerRetentionDays: 30,
    });
    expect(
      resolveDaemonConfig({
        CARGO_HAULER_LEDGER_MAX_ROWS: '0',
        CARGO_HAULER_LEDGER_RETENTION_DAYS: '0',
      }),
    ).toMatchObject({ ledgerMaxRows: 0, ledgerRetentionDays: 0 });
    expect(
      resolveDaemonConfig({
        CARGO_HAULER_LEDGER_MAX_ROWS: '1000',
        CARGO_HAULER_LEDGER_RETENTION_DAYS: '7.5',
      }),
    ).toMatchObject({ ledgerMaxRows: 1_000, ledgerRetentionDays: 7.5 });
    const invalid = resolveDaemonConfigWithWarnings({
      CARGO_HAULER_LEDGER_MAX_ROWS: '-5',
      CARGO_HAULER_LEDGER_RETENTION_DAYS: 'soon',
    });
    expect(invalid.config).toMatchObject({ ledgerMaxRows: 50_000, ledgerRetentionDays: 30 });
    expect(invalid.warnings).toHaveLength(2);
  });
});

describe('admission permit defaults', () => {
  it('scales default permits with cores, one per eight, clamped between 5 and 16', () => {
    expect(defaultMaxConcurrentFor(4)).toBe(5);
    expect(defaultMaxConcurrentFor(40)).toBe(5);
    expect(defaultMaxConcurrentFor(48)).toBe(6);
    expect(defaultMaxConcurrentFor(96)).toBe(12);
    expect(defaultMaxConcurrentFor(256)).toBe(16);
    expect(defaultMaxConcurrentFor(Number.NaN)).toBe(5);
  });

  it('threads the core count into the default permits and the per-run jobs grant', () => {
    const quiet = () => {};
    const big = resolveDaemonConfig({ CARGO_HAULER_STATE_DIR: '/tmp/cc-test' }, 'linux', quiet, 96);
    expect(big.maxConcurrent).toBe(12);
    expect(big.jobsGrant).toBe(8);
    const small = resolveDaemonConfig({ CARGO_HAULER_STATE_DIR: '/tmp/cc-test' }, 'linux', quiet, 8);
    expect(small.maxConcurrent).toBe(5);
    expect(small.jobsGrant).toBe(4);
  });

  it('lets CARGO_HAULER_MAX_CONCURRENT override the scaled default', () => {
    const config = resolveDaemonConfig(
      { CARGO_HAULER_MAX_CONCURRENT: '3', CARGO_HAULER_STATE_DIR: '/tmp/cc-test' },
      'linux',
      () => {},
      96,
    );
    expect(config.maxConcurrent).toBe(3);
    expect(config.jobsGrant).toBe(32);
  });

  it('overlaps execution phases by default and honors the opt-out', () => {
    expect(resolveDaemonConfig({ CARGO_HAULER_STATE_DIR: '/tmp/cc-test' }).overlapExecution).toBe(true);
    expect(
      resolveDaemonConfig({ CARGO_HAULER_OVERLAP_EXECUTION: '0', CARGO_HAULER_STATE_DIR: '/tmp/cc-test' })
        .overlapExecution,
    ).toBe(false);
    expect(
      resolveDaemonConfig({ CARGO_HAULER_OVERLAP_EXECUTION: 'false', CARGO_HAULER_STATE_DIR: '/tmp/cc-test' })
        .overlapExecution,
    ).toBe(false);
  });
});
