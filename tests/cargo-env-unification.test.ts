import { describe, expect, it } from 'effect-rstest';

import { buildRelevantEnv } from '../src/client/env.js';
import { digestCargoEnvironment } from '../src/daemon/intent-normalizer.js';
import {
  isRelevantCargoEnvironmentVariable,
  isTransportedEnvironmentVariable,
} from '../src/lib/cargo-env.js';

describe('cargo environment relevance', () => {
  it('transports every identity-relevant variable the digest sees', () => {
    const env = {
      CARGO_TARGET_DIR: '/tmp/target',
      CARGO_HAULER_STATE_DIR: '/tmp/state',
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
    expect(isRelevantCargoEnvironmentVariable('CARGO_HAULER_STATE_DIR')).toBe(false);
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

  it('transports color-decision variables without letting them into identity', () => {
    for (const name of ['CLICOLOR', 'CLICOLOR_FORCE', 'FORCE_COLOR', 'NO_COLOR', 'TERM']) {
      expect(isTransportedEnvironmentVariable(name)).toBe(true);
      expect(isRelevantCargoEnvironmentVariable(name)).toBe(false);
    }
    // Sessions differing only in color/terminal env must still coalesce.
    const base = { RUSTFLAGS: '-Dwarnings' };
    expect(
      digestCargoEnvironment({ ...base, NO_COLOR: '1', TERM: 'dumb' }),
    ).toBe(digestCargoEnvironment(base));
    expect(
      digestCargoEnvironment(buildRelevantEnv({ ...base, FORCE_COLOR: '1', TERM: 'xterm-256color' })),
    ).toBe(digestCargoEnvironment(base));
  });
});
