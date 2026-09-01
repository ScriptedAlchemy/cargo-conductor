import { describe, expect, it } from '@rstest/core';

import { buildRelevantEnv } from '../src/client/env.js';
import { digestCargoEnvironment } from '../src/daemon/intent-normalizer.js';
import { isRelevantCargoEnvironmentVariable } from '../src/lib/cargo-env.js';

describe('cargo environment relevance', () => {
  it('uses one superset for client transport and intent identity', () => {
    const env = {
      CARGO_TARGET_DIR: '/tmp/target',
      CARGO_CONDUCTOR_STATE_DIR: '/tmp/state',
      CC_aarch64_unknown_linux_gnu: 'clang',
      CFLAGS: '-O2',
      CXXFLAGS: '-O3',
      HOME: '/home/test',
      LDFLAGS: '-fuse-ld=lld',
      RUSTFLAGS: '-Dwarnings',
    };

    expect(buildRelevantEnv(env)).toEqual({
      CARGO_TARGET_DIR: '/tmp/target',
      CC_aarch64_unknown_linux_gnu: 'clang',
      CFLAGS: '-O2',
      CXXFLAGS: '-O3',
      LDFLAGS: '-fuse-ld=lld',
      RUSTFLAGS: '-Dwarnings',
    });
    expect(isRelevantCargoEnvironmentVariable('CFLAGS')).toBe(true);
    expect(isRelevantCargoEnvironmentVariable('CC_aarch64_unknown_linux_gnu')).toBe(true);
    expect(isRelevantCargoEnvironmentVariable('CARGO_CONDUCTOR_STATE_DIR')).toBe(false);
    expect(isRelevantCargoEnvironmentVariable('HOME')).toBe(false);
  });

  it('separates intent digests for newly transported compiler variables', () => {
    expect(digestCargoEnvironment({ CFLAGS: '-O1' })).not.toBe(
      digestCargoEnvironment({ CFLAGS: '-O2' }),
    );
    expect(digestCargoEnvironment({ CC_aarch64_unknown_linux_gnu: 'gcc' })).not.toBe(
      digestCargoEnvironment({ CC_aarch64_unknown_linux_gnu: 'clang' }),
    );
  });
});
