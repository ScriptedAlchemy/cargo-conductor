import { describe, expect, it } from '@rstest/core';

import { attachModeFor } from '../src/daemon/coverage.js';
import { normalizeCargoIntent } from '../src/daemon/intent-normalizer.js';
import type { NormalizedCargoIntent } from '../src/daemon/intent-normalizer.js';

const workspaceRoot = '/fixture/ws';

const intent = (
  argv: readonly string[],
  overrides: {
    readonly cwd?: string;
    readonly env?: Readonly<Record<string, string>>;
  } = {},
): NormalizedCargoIntent =>
  normalizeCargoIntent({
    argv: ['cargo', ...argv],
    cwd: overrides.cwd ?? workspaceRoot,
    env: overrides.env ?? {},
    workspaceRoot,
  });

describe('attachModeFor identity', () => {
  it('coalesces byte-identical broad checks (the mined 96% duplicate storm)', () => {
    const leader = intent(['check', '--all-features']);
    const candidate = intent(['check', '--all-features']);
    expect(attachModeFor(leader, candidate)).toBe('identity');
  });

  it('coalesces identical tests but only at identity', () => {
    const leader = intent(['test', '-p', 'tracedecay', '--lib']);
    expect(attachModeFor(leader, intent(['test', '-p', 'tracedecay', '--lib']))).toBe('identity');
    expect(attachModeFor(leader, intent(['test', '-p', 'tracedecay']))).toBeNull();
  });

  it('treats identical opaque flags as identity but never coverage', () => {
    const leader = intent(['check', '--offline', '-p', 'aa']);
    expect(attachModeFor(leader, intent(['check', '--offline', '-p', 'aa']))).toBe('identity');
    // --offline is opaque; a weaker request cannot prove coverage under it.
    expect(attachModeFor(leader, intent(['check', '-p', 'aa']))).toBeNull();
  });

  it('never coalesces side-effecting subcommands even when identical', () => {
    const leader = intent(['run', '--bin', 'server']);
    expect(attachModeFor(leader, intent(['run', '--bin', 'server']))).toBeNull();
  });

  it('distinguishes intents that differ only in compilation environment', () => {
    const leader = intent(['check'], { env: { RUSTFLAGS: '-Dwarnings' } });
    expect(attachModeFor(leader, intent(['check']))).toBeNull();
    // Non-compilation env vars do not fragment identity.
    const noisy = intent(['check'], { env: { FAKE_SLEEP: '1' } });
    expect(attachModeFor(intent(['check']), noisy)).toBe('identity');
  });
});

describe('attachModeFor coverage', () => {
  it('lets a narrow check ride a wider build of the same surface', () => {
    const leader = intent(['build', '-p', 'aa', '-p', 'bb']);
    expect(attachModeFor(leader, intent(['check', '-p', 'aa']))).toBe('coverage');
  });

  it('lets a package check ride a workspace check without excludes', () => {
    const leader = intent(['check', '--workspace']);
    expect(attachModeFor(leader, intent(['check', '-p', 'aa']))).toBe('coverage');
  });

  it('refuses coverage when the stronger run excludes the weaker package', () => {
    const leader = intent(['check', '--workspace', '--exclude', 'aa']);
    expect(attachModeFor(leader, intent(['check', '-p', 'aa']))).toBeNull();
    expect(attachModeFor(leader, intent(['check', '-p', 'bb']))).toBe('coverage');
  });

  it('covers default targets under --all-targets but not the reverse', () => {
    const allTargets = intent(['check', '-p', 'aa', '--all-targets']);
    const defaultTargets = intent(['check', '-p', 'aa']);
    const libOnly = intent(['check', '-p', 'aa', '--lib']);
    expect(attachModeFor(allTargets, defaultTargets)).toBe('coverage');
    expect(attachModeFor(allTargets, libOnly)).toBe('coverage');
    expect(attachModeFor(libOnly, defaultTargets)).toBeNull();
  });

  it('requires an exact feature and profile surface', () => {
    const leader = intent(['build', '-p', 'aa', '--all-features']);
    expect(attachModeFor(leader, intent(['check', '-p', 'aa']))).toBeNull();
    expect(attachModeFor(leader, intent(['check', '-p', 'aa', '--all-features']))).toBe(
      'coverage',
    );
    expect(
      attachModeFor(intent(['build', '-p', 'aa', '--release']), intent(['check', '-p', 'aa'])),
    ).toBeNull();
  });

  it('never lets check cover under test or clippy leaders', () => {
    expect(attachModeFor(intent(['test', '-p', 'aa']), intent(['check', '-p', 'aa']))).toBeNull();
    expect(
      attachModeFor(intent(['clippy', '-p', 'aa']), intent(['check', '-p', 'aa'])),
    ).toBeNull();
  });

  it('treats default-package requests as coverable only from the same cwd', () => {
    const leaderSameCwd = intent(['build']);
    const candidateSameCwd = intent(['check']);
    expect(attachModeFor(leaderSameCwd, candidateSameCwd)).toBe('coverage');
    const candidateOtherCwd = intent(['check'], { cwd: `${workspaceRoot}/crates/aa` });
    expect(attachModeFor(leaderSameCwd, candidateOtherCwd)).toBeNull();
  });

  it('covers a workspace check only when the stronger excludes nothing extra', () => {
    const leader = intent(['build', '--workspace', '--exclude', 'slow-crate']);
    expect(attachModeFor(leader, intent(['check', '--workspace']))).toBeNull();
    expect(
      attachModeFor(leader, intent(['check', '--workspace', '--exclude', 'slow-crate'])),
    ).toBe('coverage');
  });
});
