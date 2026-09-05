import { describe, expect, it } from 'effect-rstest';

import { attachDecisionFor } from '../src/daemon/coverage.js';
import { normalizeCargoIntent } from '../src/daemon/intent-normalizer.js';
import { planDemux } from '../src/daemon/job-state.js';

const intent = (argv: readonly string[]) =>
  normalizeCargoIntent({ argv, cwd: '/tmp/ws', env: {}, workspaceRoot: '/tmp/ws' });

describe('env-prefixed requests', () => {
  it('identity-attach to a byte-identical request and demux like a plain compile', () => {
    const leader = intent(['env', 'FOO=1', 'cargo', 'build', '-p', 'alpha']);
    const rider = intent(['env', 'FOO=1', 'cargo', 'build', '-p', 'alpha']);
    expect(attachDecisionFor(leader, rider)).toEqual({ _tag: 'attach', mode: 'identity' });
    const plan = planDemux(leader, ['env', 'FOO=1', 'cargo', 'build', '-p', 'alpha']);
    expect(plan.demux).not.toBeNull();
    expect(plan.execArgv).toEqual(['env', 'FOO=1', 'cargo', 'build', '-p', 'alpha', '--message-format=json-diagnostic-rendered-ansi']);
  });

  it('let a check ride an env-prefixed build when the compile-relevant assignments match', () => {
    const leader = intent(['env', 'RUSTFLAGS=-Dwarnings', 'cargo', 'build', '-p', 'alpha']);
    expect(
      attachDecisionFor(leader, intent(['env', 'RUSTFLAGS=-Dwarnings', 'cargo', 'check', '-p', 'alpha'])),
    ).toEqual({ _tag: 'attach', mode: 'coverage' });
    expect(attachDecisionFor(leader, intent(['cargo', 'check', '-p', 'alpha']))).toMatchObject({
      _tag: 'rejected',
      gate: 'compile-surface',
    });
    // An assignment outside the compile-relevant set (a test-only variable)
    // separates identities but, like any other request environment, does
    // not change what a build proves for a check.
    expect(
      attachDecisionFor(intent(['env', 'FOO=1', 'cargo', 'build', '-p', 'alpha']), intent(['cargo', 'check', '-p', 'alpha'])),
    ).toEqual({ _tag: 'attach', mode: 'coverage' });
  });
});

describe('shell-wrapped requests', () => {
  const wrapped = intent(['bash', '-lc', 'source x.sh; cargo build -p alpha']);

  it('never lead, ride, or fold, even when byte-identical', () => {
    const twin = intent(['bash', '-lc', 'source x.sh; cargo build -p alpha']);
    expect(attachDecisionFor(wrapped, twin)).toMatchObject({ _tag: 'rejected', gate: 'shell-wrapped' });
    expect(attachDecisionFor(wrapped, intent(['cargo', 'check', '-p', 'alpha']))).toMatchObject({
      _tag: 'rejected',
      gate: 'shell-wrapped',
    });
    expect(attachDecisionFor(intent(['cargo', 'build', '-p', 'alpha']), wrapped)).toMatchObject({
      _tag: 'rejected',
      gate: 'shell-wrapped',
    });
  });

  it('are never demuxed: the flag would land on the shell, not on cargo', () => {
    const plan = planDemux(wrapped, ['bash', '-lc', 'source x.sh; cargo build -p alpha']);
    expect(plan.demux).toBeNull();
    expect(plan.execArgv).toEqual(['bash', '-lc', 'source x.sh; cargo build -p alpha']);
  });
});
