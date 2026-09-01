import { describe, expect, it } from '@rstest/core';

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

  it('falls back to legacy config variables and gives hauler variables precedence', () => {
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
