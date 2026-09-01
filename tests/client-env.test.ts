import { describe, expect, it } from '@rstest/core';

import { buildRelevantEnv } from '../src/client/env.js';

describe('buildRelevantEnv', () => {
  it('keeps build-affecting variables and drops session noise', () => {
    const env = {
      CARGO_TARGET_DIR: '/tmp/t',
      CC: 'clang',
      HOME: '/home/alice',
      PATH: '/usr/bin',
      PROMPT_COMMAND: 'noise',
      RUSTFLAGS: '-C debuginfo=1',
      RUSTUP_TOOLCHAIN: 'nightly',
    };
    expect(buildRelevantEnv(env)).toEqual({
      CARGO_TARGET_DIR: '/tmp/t',
      CC: 'clang',
      RUSTFLAGS: '-C debuginfo=1',
      RUSTUP_TOOLCHAIN: 'nightly',
    });
  });

  it('never leaks conductor-internal variables', () => {
    expect(
      buildRelevantEnv({
        CARGO_CONDUCTOR_CARGO_BIN: '/fake/cargo',
        CARGO_CONDUCTOR_STATE_DIR: '/tmp/state',
        RUSTDOCFLAGS: '--cfg docsrs',
      }),
    ).toEqual({ RUSTDOCFLAGS: '--cfg docsrs' });
  });

  it('skips undefined values', () => {
    expect(buildRelevantEnv({ RUSTFLAGS: undefined })).toEqual({});
  });

  it('transports the caller color-decision variables to the daemon spawn', () => {
    // A caller NO_COLOR must reach the executor, or it injects
    // CARGO_TERM_COLOR=always and ANSI leaks through unstripped stdout.
    expect(
      buildRelevantEnv({
        CLICOLOR: '0',
        CLICOLOR_FORCE: '1',
        FORCE_COLOR: '1',
        HOME: '/home/alice',
        NO_COLOR: '1',
        TERM: 'dumb',
      }),
    ).toEqual({
      CLICOLOR: '0',
      CLICOLOR_FORCE: '1',
      FORCE_COLOR: '1',
      NO_COLOR: '1',
      TERM: 'dumb',
    });
  });
});
