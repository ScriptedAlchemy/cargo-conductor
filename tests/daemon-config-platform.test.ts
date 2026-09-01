import { describe, expect, it } from '@rstest/core';

import { UnsupportedPlatformError, resolveDaemonConfig } from '../src/daemon/config.js';

describe('daemon config platform posture', () => {
  it('fails on win32 with one clear unsupported error, not a cryptic socket error', () => {
    expect(() => resolveDaemonConfig({}, 'win32')).toThrow(/Windows is not yet supported/u);
    let caught: unknown;
    try {
      resolveDaemonConfig({}, 'win32');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(UnsupportedPlatformError);
    expect((caught as UnsupportedPlatformError)._tag).toBe('UnsupportedPlatform');
  });

  it('resolves normally on POSIX platforms', () => {
    for (const platform of ['linux', 'darwin'] as const) {
      const config = resolveDaemonConfig({ CARGO_CONDUCTOR_STATE_DIR: '/tmp/cc-test' }, platform);
      expect(config.socketPath.endsWith('daemon.sock')).toBe(true);
    }
  });
});
