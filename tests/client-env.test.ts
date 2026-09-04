import { describe, expect, it } from 'effect-rstest';

import { buildTransportedEnv } from '../src/client/env.js';

describe('buildTransportedEnv', () => {
  it('forwards the caller environment, including build-script knobs cargo cannot name up front', () => {
    const env = {
      CARGO_TARGET_DIR: '/tmp/t',
      CC: 'clang',
      FOO: 'bar',
      HOME: '/home/alice',
      PATH: '/usr/bin',
      PROMPT_COMMAND: 'noise',
      RUSTFLAGS: '-C debuginfo=1',
      RUSTUP_TOOLCHAIN: 'nightly',
      TRACEDECAY_SKIP_DASHBOARD_BUILD: '1',
    };
    // A `build.rs` reading FOO or TRACEDECAY_SKIP_DASHBOARD_BUILD must see the
    // caller's value through the broker, exactly as a direct cargo run would.
    expect(buildTransportedEnv(env)).toEqual(env);
  });

  it('never leaks hauler-internal variables', () => {
    expect(
      buildTransportedEnv({
        CARGO_CONDUCTOR_KILL_GRACE_MS: '1',
        CARGO_HAULER_CARGO_BIN: '/fake/cargo',
        CARGO_HAULER_STATE_DIR: '/tmp/state',
        RUSTDOCFLAGS: '--cfg docsrs',
      }),
    ).toEqual({ RUSTDOCFLAGS: '--cfg docsrs' });
  });

  it('drops jobserver flags whose descriptors cannot exist in the daemon', () => {
    // A client started by `make` inherits `--jobserver-auth=R,W` (or the
    // older `--jobserver-fds=`): those are the caller's file descriptors,
    // meaningless in another process. Cargo would honour them anyway and the
    // daemon's own FIFO jobserver would be skipped for the run.
    expect(
      buildTransportedEnv({
        CARGO_MAKEFLAGS: '-j --jobserver-fds=3,4 --jobserver-auth=3,4',
        MAKEFLAGS: ' -j8 --jobserver-auth=3,4',
        MFLAGS: '-j8 --jobserver-auth=3,4',
        RUSTFLAGS: '-C debuginfo=1',
      }),
    ).toEqual({ RUSTFLAGS: '-C debuginfo=1' });
    // A FIFO-backed jobserver is a path and travels fine, as do plain flags.
    expect(
      buildTransportedEnv({
        MAKEFLAGS: '-j --jobserver-auth=fifo:/tmp/make-jobserver',
        MFLAGS: '-k',
      }),
    ).toEqual({
      MAKEFLAGS: '-j --jobserver-auth=fifo:/tmp/make-jobserver',
      MFLAGS: '-k',
    });
  });

  it('skips undefined values', () => {
    expect(buildTransportedEnv({ RUSTFLAGS: undefined })).toEqual({});
  });

  it('transports the caller color-decision variables to the daemon spawn', () => {
    // A caller NO_COLOR must reach the executor, or it injects
    // CARGO_TERM_COLOR=always and ANSI leaks through unstripped stdout.
    expect(
      buildTransportedEnv({
        CLICOLOR: '0',
        CLICOLOR_FORCE: '1',
        FORCE_COLOR: '1',
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
