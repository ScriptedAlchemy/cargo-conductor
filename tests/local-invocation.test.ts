import { describe, expect, it } from '@rstest/core';

import { localQueryReason } from '../src/client/local-invocation.js';

describe('localQueryReason', () => {
  it('classifies help and version flags anywhere before the -- separator', () => {
    expect(localQueryReason(['cargo', '--help'])).toContain('--help');
    expect(localQueryReason(['cargo', 'build', '--help'])).toContain('--help');
    expect(localQueryReason(['cargo', '-V'])).toContain('-V');
    expect(localQueryReason(['cargo', 'hauler', '--help'])).toContain('--help');
    expect(localQueryReason(['cargo', '--list'])).toContain('--list');
  });

  it('classifies non-compiling query subcommands', () => {
    expect(localQueryReason(['cargo', 'metadata', '--format-version', '1'])).toContain('metadata');
    expect(localQueryReason(['cargo', 'tree', '-p', 'alpha'])).toContain('tree');
    expect(localQueryReason(['cargo', 'help', 'build'])).toContain('help');
    expect(localQueryReason(['cargo', 'version'])).toContain('version');
    expect(localQueryReason(['cargo', 'pkgid'])).toContain('pkgid');
  });

  it('classifies a bare cargo invocation, which prints usage locally', () => {
    expect(localQueryReason(['cargo'])).not.toBeNull();
  });

  it('keeps compile-shaped work brokered', () => {
    expect(localQueryReason(['cargo', 'check'])).toBeNull();
    expect(localQueryReason(['cargo', 'build', '--release'])).toBeNull();
    expect(localQueryReason(['cargo', 'test', '-p', 'alpha'])).toBeNull();
    expect(localQueryReason(['cargo', 'nextest', 'run'])).toBeNull();
    expect(localQueryReason(['cargo', 'clippy'])).toBeNull();
  });

  it('keeps unknown third-party subcommands brokered', () => {
    expect(localQueryReason(['cargo', 'flamegraph'])).toBeNull();
    expect(localQueryReason(['cargo', 'hauler'])).toBeNull();
  });

  it('does not treat program arguments after -- as query flags', () => {
    expect(localQueryReason(['cargo', 'run', '--', '--help'])).toBeNull();
    expect(localQueryReason(['cargo', 'test', '-p', 'alpha', '--', '--list'])).toBeNull();
  });
});
