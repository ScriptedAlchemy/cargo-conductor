import { describe, expect, it } from 'effect-rstest';

import {
  attachDecisionFor,
  attachModeFor,
  attachRejectionRank,
  isBuildOnlyIntent,
} from '../src/daemon/coverage.js';
import type { AttachDecision } from '../src/daemon/coverage.js';
import { normalizeCargoIntent } from '../src/daemon/intent-normalizer.js';
import type { NormalizedCargoIntent } from '../src/daemon/intent-normalizer.js';
import { attachRejectionGates } from '../src/daemon/protocol.js';
import type { AttachRejectionGate } from '../src/daemon/protocol.js';

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

  it('treats identical opaque flags as identity and differing ones as no coverage', () => {
    const leader = intent(['check', '--offline', '-p', 'aa']);
    expect(attachModeFor(leader, intent(['check', '--offline', '-p', 'aa']))).toBe('identity');
    // --offline is opaque; a weaker request without it is not proven by a
    // run under it (the flags differ), see the #89 gates below for the
    // identical-flags case.
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

const gateOf = (decision: AttachDecision): AttachRejectionGate | 'attached' => {
  switch (decision._tag) {
    case 'attach':
      return 'attached';
    case 'rejected':
      return decision.gate;
    default: {
      const exhaustive: never = decision;
      return exhaustive;
    }
  }
};

const coverage = (leader: readonly string[], candidate: readonly string[]): AttachDecision =>
  attachDecisionFor(intent(leader), intent(candidate));

/**
 * The argv shapes below are the ones the production ledger actually
 * recorded over four days with zero coverage attachments (#89): `--locked`
 * on nearly every check, `--bin` builds of the CLI, `--tests` checks, and
 * `test … --no-run` compiles queued behind filtered test runs (#88).
 */
describe('attachDecisionFor gates (#89)', () => {
  it('names the gate that refused the pair, in evaluation order', () => {
    expect(attachRejectionGates).toEqual([
      'shell-wrapped',
      'subcommand',
      'opaque-arguments',
      'passthrough',
      'compile-surface',
      'packages',
      'targets',
      'channels',
      'leader-build-finished',
    ]);
    expect(attachRejectionRank('targets')).toBeGreaterThan(attachRejectionRank('subcommand'));
    expect(attachRejectionRank('leader-build-finished')).toBe(attachRejectionGates.length - 1);
  });

  it('lets identical unmodeled flags through: --locked on both sides still proves the check', () => {
    const decision = coverage(
      ['check', '-p', 'tracedecay', '--no-default-features', '--locked'],
      ['check', '-p', 'tracedecay', '--lib', '--no-default-features', '--locked'],
    );
    expect(decision).toEqual({ _tag: 'attach', mode: 'coverage' });
  });

  it('still refuses differing unmodeled flags and says so', () => {
    const decision = coverage(
      ['check', '-p', 'tracedecay', '--no-default-features', '--locked'],
      ['check', '-p', 'tracedecay', '--lib', '--no-default-features'],
    );
    expect(gateOf(decision)).toBe('opaque-arguments');
    expect(decision._tag === 'rejected' ? decision.detail : '').toContain('--locked');
    expect(gateOf(coverage(['check', '-p', 'aa'], ['check', '-p', 'aa', '--offline']))).toBe(
      'opaque-arguments',
    );
  });

  it('lets a CLI check ride the CLI build it was queued behind', () => {
    expect(
      gateOf(
        coverage(
          ['build', '-p', 'tracedecay-cli', '--bin', 'tracedecay', '--locked'],
          ['check', '-p', 'tracedecay-cli', '--bin', 'tracedecay', '--locked'],
        ),
      ),
    ).toBe('attached');
    // The release build is another surface.
    expect(
      gateOf(
        coverage(
          ['build', '--locked', '--release', '-p', 'tracedecay-cli', '--bin', 'tracedecay'],
          ['check', '-p', 'tracedecay-cli', '--bin', 'tracedecay', '--locked'],
        ),
      ),
    ).toBe('compile-surface');
  });

  it('treats byte-equal passthrough as shared and differing passthrough as a gate', () => {
    expect(
      gateOf(coverage(['build', '-p', 'aa', '--', '-Dwarnings'], ['check', '-p', 'aa', '--', '-Dwarnings'])),
    ).toBe('attached');
    expect(
      gateOf(coverage(['build', '-p', 'aa', '--', '-Dwarnings'], ['check', '-p', 'aa'])),
    ).toBe('passthrough');
    expect(
      gateOf(coverage(['build', '-p', 'aa'], ['check', '-p', 'aa', '--', '-Dwarnings'])),
    ).toBe('passthrough');
  });

  it('lets check --tests ride build --tests or build --all-targets, never a plain build', () => {
    const rider = ['check', '-p', 'tracedecay-sessions', '-p', 'tracedecay-host-admission', '--tests'];
    expect(gateOf(coverage(['build', '-p', 'tracedecay-sessions', '-p', 'tracedecay-host-admission', '--tests'], rider))).toBe('attached');
    expect(gateOf(coverage(['build', '--workspace', '--all-targets'], rider))).toBe('attached');
    // Gates fall in evaluation order: the unmodeled `--locked` is reported
    // before the feature difference behind it.
    expect(gateOf(coverage(['check', '--workspace', '--all-targets', '--features', 'hotpath,hotpath-mcp', '--locked'], rider))).toBe('opaque-arguments');
    expect(gateOf(coverage(['check', '--workspace', '--all-targets', '--features', 'hotpath,hotpath-mcp'], rider))).toBe('compile-surface');
    const plain = coverage(['build', '-p', 'tracedecay-sessions', '-p', 'tracedecay-host-admission'], rider);
    expect(gateOf(plain)).toBe('targets');
    expect(plain._tag === 'rejected' ? plain.detail : '').toContain('default targets');
  });

  it('covers a named bin or example under its plural flag, but not a named test under --tests', () => {
    expect(gateOf(coverage(['build', '-p', 'aa', '--bins'], ['check', '-p', 'aa', '--bin', 'tool']))).toBe('attached');
    expect(gateOf(coverage(['build', '-p', 'aa', '--examples'], ['check', '-p', 'aa', '--example', 'demo']))).toBe('attached');
    // `--tests` selects only targets with `test = true`; `--test foo` builds foo regardless.
    expect(gateOf(coverage(['build', '-p', 'aa', '--tests'], ['check', '-p', 'aa', '--test', 'foo']))).toBe('targets');
  });

  it('never lets check ride clippy, and names the subcommand gate', () => {
    const decision = coverage(
      ['clippy', '-p', 'tracedecay-maintenance', '--all-targets', '--', '-D', 'warnings'],
      ['check', '-p', 'tracedecay-maintenance', '--all-targets', '--', '-D', 'warnings'],
    );
    expect(gateOf(decision)).toBe('subcommand');
    expect(gateOf(coverage(['run', '--bin', 'server'], ['run', '--bin', 'server']))).toBe('subcommand');
  });

  it('keeps refusing a -p rider under a default-package leader at the workspace root, naming packages', () => {
    const decision = coverage(['build'], ['check', '-p', 'aa']);
    expect(gateOf(decision)).toBe('packages');
    expect(decision._tag === 'rejected' ? decision.detail : '').toContain('default package set');
    expect(gateOf(coverage(['build', '-p', 'aa'], ['check', '-p', 'aa', '-p', 'bb']))).toBe('packages');
  });

  it('reports the compile-surface field that differs', () => {
    const decision = coverage(['build', '-p', 'aa', '--all-features'], ['check', '-p', 'aa']);
    expect(decision).toEqual({ _tag: 'rejected', gate: 'compile-surface', detail: 'features differs' });
    const profile = coverage(['build', '-p', 'aa', '--release'], ['check', '-p', 'aa']);
    expect(profile._tag === 'rejected' ? profile.detail : '').toBe('profile differs');
  });
});

describe('test --no-run riding a running test (#88)', () => {
  it('recognizes a --no-run test or bench as build-only without moving the flag out of the intent', () => {
    const noRun = intent(['test', '-p', 'tracedecay', '--lib', '--no-run']);
    expect(isBuildOnlyIntent(noRun)).toBe(true);
    expect(noRun.opaqueArguments).toContain('--no-run');
    expect(isBuildOnlyIntent(intent(['test', '-p', 'tracedecay', '--lib']))).toBe(false);
    expect(isBuildOnlyIntent(intent(['bench', '-p', 'aa', '--bench', 'wal', '--no-run']))).toBe(true);
    expect(isBuildOnlyIntent(intent(['check', '-p', 'aa']))).toBe(false);
  });

  it('lets the observed cc-5527 shape ride cc-5526: same package and --lib, leader filters ignored', () => {
    const leader = [
      'test', '-p', 'tracedecay', '--lib',
      'daemon::tests::rmcp_route', 'mcp::server::tests::wire', 'a::b', 'c::d',
      '--', '--test-threads=4',
    ];
    expect(coverage(leader, ['test', '-p', 'tracedecay', '--lib', '--no-run'])).toEqual({
      _tag: 'attach',
      mode: 'coverage',
    });
  });

  it('ignores --exact/--nocapture passthrough and a --no-fail-fast leader, and the rider\'s own filters', () => {
    const leader = [
      'test', '-p', 'tracedecay-store-runtime', '--lib', '--no-fail-fast',
      'session_registry::code_graph::sealed_publication_tests::sealed_generation_publishes',
      '--', '--exact', '--nocapture',
    ];
    expect(gateOf(coverage(leader, ['test', '-p', 'tracedecay-store-runtime', '--lib', '--no-run']))).toBe('attached');
    expect(
      gateOf(coverage(leader, ['test', '-p', 'tracedecay-store-runtime', '--lib', 'some_filter', '--no-run', '--', '--exact'])),
    ).toBe('attached');
  });

  it('requires the same features and --locked, since those change what compiles', () => {
    const leader = [
      'test', '-p', 'tracedecay', '--lib', 'mcp::server::rmcp::tests::rmcp_wire_matrix',
      '--features', 'test-transport', '--locked', '--', '--exact',
    ];
    expect(
      gateOf(coverage(leader, ['test', '-p', 'tracedecay', '--features', 'test-transport', '--lib', '--locked', '--no-run'])),
    ).toBe('attached');
    expect(gateOf(coverage(leader, ['test', '-p', 'tracedecay', '--lib', '--locked', '--no-run']))).toBe(
      'compile-surface',
    );
    expect(
      gateOf(coverage(leader, ['test', '-p', 'tracedecay', '--features', 'test-transport', '--lib', '--no-run'])),
    ).toBe('opaque-arguments');
  });

  it('does not attach across target selections: --lib vs --test foo, or default vs explicit', () => {
    expect(gateOf(coverage(['test', '-p', 'aa', '--test', 'mcp_suite'], ['test', '-p', 'aa', '--lib', '--no-run']))).toBe('targets');
    expect(gateOf(coverage(['test', '-p', 'aa', '--lib'], ['test', '-p', 'aa', '--test', 'mcp_suite', '--no-run']))).toBe('targets');
    // The default test set depends on each target's `test = true` flag, which
    // the intent cannot see: it covers only another default selection.
    expect(gateOf(coverage(['test', '-p', 'aa'], ['test', '-p', 'aa', '--lib', '--no-run']))).toBe('targets');
    expect(gateOf(coverage(['test', '-p', 'aa', '--lib'], ['test', '-p', 'aa', '--no-run']))).toBe('targets');
    expect(gateOf(coverage(['test', '-p', 'aa'], ['test', '-p', 'aa', '--no-run']))).toBe('attached');
    expect(gateOf(coverage(['test', '-p', 'aa', '--all-targets'], ['test', '-p', 'aa', '--lib', '--no-run']))).toBe('attached');
    expect(gateOf(coverage(['test', '-p', 'aa', '--doc'], ['test', '-p', 'aa', '--lib', '--no-run']))).toBe('targets');
  });

  it('only a --no-run rider rides, only under the same subcommand', () => {
    // A test that runs wants results a differently filtered leader cannot give it.
    expect(gateOf(coverage(['test', '-p', 'aa', '--lib', 'alpha'], ['test', '-p', 'aa', '--lib', 'beta']))).toBe('subcommand');
    // A running rider never rides a --no-run leader either.
    expect(gateOf(coverage(['test', '-p', 'aa', '--lib', '--no-run'], ['test', '-p', 'aa', '--lib']))).toBe('subcommand');
    expect(gateOf(coverage(['bench', '-p', 'aa', '--bench', 'wal'], ['test', '-p', 'aa', '--bench', 'wal', '--no-run']))).toBe('subcommand');
    expect(gateOf(coverage(['nextest', 'run', '-p', 'aa', '--lib'], ['test', '-p', 'aa', '--lib', '--no-run']))).toBe('subcommand');
    expect(gateOf(coverage(['bench', '-p', 'aa', '--bench', 'wal'], ['bench', '-p', 'aa', '--bench', 'wal', '--no-run']))).toBe('attached');
    // Two --no-run compiles that differ only in an unused filter cover each other.
    expect(gateOf(coverage(['test', '-p', 'aa', '--lib', 'alpha', '--no-run'], ['test', '-p', 'aa', '--lib', '--no-run']))).toBe('attached');
  });

  it('keeps identity ahead of coverage for byte-identical --no-run requests', () => {
    expect(attachModeFor(intent(['test', '-p', 'aa', '--lib', '--no-run']), intent(['test', '-p', 'aa', '--lib', '--no-run']))).toBe('identity');
  });
});
