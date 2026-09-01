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
});
