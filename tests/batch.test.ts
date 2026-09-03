import { describe, expect, it } from 'effect-rstest';

import {
  batchCompatible,
  batchCompatibleFor,
  batchExitShared,
  batchKindFor,
  composeNextestBatchArgv,
  composeTestBatchArgv,
  extraPackagesFor,
  maxBatchPackages,
  withExtraPackages,
} from '../src/daemon/batch.js';
import { normalizeCargoIntent } from '../src/daemon/intent-normalizer.js';

const intent = (argv: readonly string[], cwd = '/tmp/ws') =>
  normalizeCargoIntent({
    argv,
    cwd,
    env: {},
    workspaceRoot: cwd,
  });

describe('batchCompatible', () => {
  it('merges scoped check/build/clippy intents that share a compile surface', () => {
    expect(
      batchCompatible(
        intent(['cargo', 'check', '-p', 'alpha']),
        intent(['cargo', 'check', '-p', 'beta']),
      ),
    ).toBe(true);
    expect(
      batchCompatible(
        intent(['cargo', 'build', '-p', 'alpha', '--release']),
        intent(['cargo', 'build', '-p', 'beta', '--release']),
      ),
    ).toBe(true);
  });

  it('refuses a mismatched profile, features, toolchain, or subcommand', () => {
    expect(
      batchCompatible(
        intent(['cargo', 'check', '-p', 'alpha']),
        intent(['cargo', 'check', '-p', 'beta', '--release']),
      ),
    ).toBe(false);
    expect(
      batchCompatible(
        intent(['cargo', 'check', '-p', 'alpha']),
        intent(['cargo', 'build', '-p', 'beta']),
      ),
    ).toBe(false);
    expect(
      batchCompatible(
        intent(['cargo', 'check', '-p', 'alpha', '--all-features']),
        intent(['cargo', 'check', '-p', 'beta']),
      ),
    ).toBe(false);
  });

  it('refuses workspace-wide, default-package, test, and opaque-flag intents', () => {
    expect(
      batchCompatible(
        intent(['cargo', 'check', '--workspace']),
        intent(['cargo', 'check', '-p', 'beta']),
      ),
    ).toBe(false);
    expect(
      batchCompatible(intent(['cargo', 'check']), intent(['cargo', 'check', '-p', 'beta'])),
    ).toBe(false);
    expect(
      batchCompatible(
        intent(['cargo', 'test', '-p', 'alpha']),
        intent(['cargo', 'test', '-p', 'beta']),
      ),
    ).toBe(false);
    expect(
      batchCompatible(
        intent(['cargo', 'check', '-p', 'alpha', '-j', '4']),
        intent(['cargo', 'check', '-p', 'beta']),
      ),
    ).toBe(false);
  });
});

describe('withExtraPackages', () => {
  it('appends missing -p flags before a message-format rewrite or passthrough', () => {
    expect(withExtraPackages(['cargo', 'check', '-p', 'alpha'], ['beta', 'gamma'])).toEqual([
      'cargo',
      'check',
      '-p',
      'alpha',
      '-p',
      'beta',
      '-p',
      'gamma',
    ]);
    expect(
      withExtraPackages(
        ['cargo', 'check', '-p', 'alpha', '--message-format=json-diagnostic-rendered-ansi'],
        ['beta'],
      ),
    ).toEqual([
      'cargo',
      'check',
      '-p',
      'alpha',
      '-p',
      'beta',
      '--message-format=json-diagnostic-rendered-ansi',
    ]);
  });

  it('does not duplicate a package already present', () => {
    expect(withExtraPackages(['cargo', 'check', '-p', 'alpha'], ['alpha', 'beta'])).toEqual([
      'cargo',
      'check',
      '-p',
      'alpha',
      '-p',
      'beta',
    ]);
  });
});

describe('maxBatchPackages', () => {
  it('caps a composite invocation at 16 packages', () => {
    expect(maxBatchPackages).toBe(16);
  });
});

describe('extraPackagesFor', () => {
  it('returns packages on the follower that the leader does not already name', () => {
    expect(
      extraPackagesFor(
        intent(['cargo', 'check', '-p', 'alpha']),
        intent(['cargo', 'check', '-p', 'beta', '-p', 'alpha']),
      ),
    ).toEqual(['beta']);
  });
});

describe('batchKindFor', () => {
  it('classifies compile, test, and nextest fold shapes', () => {
    expect(batchKindFor(intent(['cargo', 'check', '-p', 'alpha']))).toBe('compile');
    expect(
      batchKindFor(intent(['cargo', 'test', '-p', 'alpha', '--test', 'contract', 'a_filter'])),
    ).toBe('test');
    expect(batchKindFor(intent(['cargo', 'test', '-p', 'alpha', '--', 'a_filter']))).toBe('test');
    expect(
      batchKindFor(intent(['cargo', 'nextest', 'run', '-p', 'alpha', '-E', 'test(x)'])),
    ).toBe('nextest');
  });

  it('allows --no-fail-fast as the only unmodeled test flag', () => {
    expect(batchKindFor(intent(['cargo', 'test', '-p', 'alpha', '--no-fail-fast']))).toBe('test');
    expect(
      batchKindFor(intent(['cargo', 'nextest', 'run', '-p', 'alpha', '--no-fail-fast'])),
    ).toBe('nextest');
  });

  it('refuses unfoldable test shapes', () => {
    // Workspace-wide and default-package runs stay on the coverage path.
    expect(batchKindFor(intent(['cargo', 'test', '--workspace']))).toBe(null);
    expect(batchKindFor(intent(['cargo', 'test']))).toBe(null);
    // Unmodeled cargo flags.
    expect(batchKindFor(intent(['cargo', 'test', '-p', 'alpha', '--no-run']))).toBe(null);
    // Target narrowing not expressible as --test flags.
    expect(batchKindFor(intent(['cargo', 'test', '-p', 'alpha', '--lib']))).toBe(null);
    // Harness flags change filter semantics for the whole run.
    expect(
      batchKindFor(intent(['cargo', 'test', '-p', 'alpha', '--', '--exact', 'a_filter'])),
    ).toBe(null);
    // Only `nextest run` folds, without positional filters, and never
    // without explicit packages (build scope would not be a superset).
    expect(batchKindFor(intent(['cargo', 'nextest', 'list', '-p', 'alpha']))).toBe(null);
    expect(batchKindFor(intent(['cargo', 'nextest', 'run', '-p', 'alpha', 'name_filter']))).toBe(
      null,
    );
    expect(batchKindFor(intent(['cargo', 'nextest', 'run', '-E', 'test(x)']))).toBe(null);
    expect(
      batchKindFor(intent(['cargo', 'nextest', 'run', '-p', 'alpha', '--lib'])),
    ).toBe(null);
  });
});

describe('batchCompatibleFor', () => {
  it('folds same-surface test intents that differ only in selection', () => {
    expect(
      batchCompatibleFor(
        'test',
        intent(['cargo', 'test', '-p', 'alpha', '--all-features', '--test', 't1', 'f1']),
        intent(['cargo', 'test', '-p', 'beta', '--all-features', '--test', 't2', 'f2']),
      ),
    ).toBe(true);
    expect(
      batchCompatibleFor(
        'nextest',
        intent(['cargo', 'nextest', 'run', '-p', 'alpha', '-E', 'test(x)']),
        intent(['cargo', 'nextest', 'run', '-p', 'beta']),
      ),
    ).toBe(true);
  });

  it('refuses compile-surface drift and cross-subcommand folds', () => {
    expect(
      batchCompatibleFor(
        'test',
        intent(['cargo', 'test', '-p', 'alpha', '--all-features']),
        intent(['cargo', 'test', '-p', 'beta']),
      ),
    ).toBe(false);
    expect(
      batchCompatibleFor(
        'test',
        intent(['cargo', 'test', '-p', 'alpha']),
        intent(['cargo', 'test', '-p', 'beta', '--release']),
      ),
    ).toBe(false);
    expect(
      batchCompatibleFor(
        'test',
        intent(['cargo', 'test', '-p', 'alpha']),
        intent(['cargo', 'nextest', 'run', '-p', 'beta']),
      ),
    ).toBe(false);
    expect(
      batchCompatibleFor(
        'nextest',
        intent(['cargo', 'nextest', 'run', '-p', 'alpha']),
        intent(['cargo', 'test', '-p', 'beta']),
      ),
    ).toBe(false);
  });
});

describe('batchExitShared', () => {
  it('shares the composite exit for test and nextest, not compile batches', () => {
    expect(batchExitShared(intent(['cargo', 'test', '-p', 'alpha', '--', 'f1']))).toBe(true);
    expect(batchExitShared(intent(['cargo', 'nextest', 'run', '-p', 'alpha']))).toBe(true);
    expect(batchExitShared(intent(['cargo', 'check', '-p', 'alpha']))).toBe(false);
  });
});

describe('composeTestBatchArgv', () => {
  it('folds the corpus pair into one --no-fail-fast composite', () => {
    const leaderArgv = [
      'cargo',
      'test',
      '-p',
      'tracedecay-graph-db',
      '--all-features',
      '--test',
      'durability_crash_contract',
      'torn_durable_store_is_quarantined_and_rebuilt',
    ];
    const leader = intent(leaderArgv);
    const follower = intent([
      'cargo',
      'test',
      '-p',
      'tracedecay-graph-db',
      '--all-features',
      '--test',
      'verified_generation_contract',
      'verify_once::a_byte_flip_under_a_stale_mark',
    ]);

    expect(composeTestBatchArgv(leaderArgv, leader, [follower])).toEqual([
      'cargo',
      'test',
      '-p',
      'tracedecay-graph-db',
      '--all-features',
      '--test',
      'durability_crash_contract',
      '--test',
      'verified_generation_contract',
      '--no-fail-fast',
      '--',
      'torn_durable_store_is_quarantined_and_rebuilt',
      'verify_once::a_byte_flip_under_a_stale_mark',
    ]);
  });

  it('drops --test narrowing and filters when a participant runs the full set', () => {
    const leaderArgv = ['cargo', 'test', '-p', 'alpha', '--test', 't1', '--', 'f1'];
    expect(
      composeTestBatchArgv(leaderArgv, intent(leaderArgv), [intent(['cargo', 'test', '-p', 'beta'])]),
    ).toEqual(['cargo', 'test', '-p', 'alpha', '-p', 'beta', '--no-fail-fast']);
  });

  it('unions positional and trailing filters without duplicates', () => {
    const leaderArgv = ['cargo', 'test', '-p', 'alpha', 'shared_filter'];
    expect(
      composeTestBatchArgv(leaderArgv, intent(leaderArgv), [
        intent(['cargo', 'test', '-p', 'alpha', '--', 'shared_filter', 'extra_filter']),
      ]),
    ).toEqual([
      'cargo',
      'test',
      '-p',
      'alpha',
      '--no-fail-fast',
      '--',
      'shared_filter',
      'extra_filter',
    ]);
  });

  it('keeps toolchain, profile, and feature flags on the composite', () => {
    const leaderArgv = [
      'cargo',
      '+nightly',
      'test',
      '-p',
      'alpha',
      '--release',
      '--no-default-features',
      '-F',
      'net,io',
      '--',
      'f1',
    ];
    expect(
      composeTestBatchArgv(leaderArgv, intent(leaderArgv), [
        intent([
          'cargo',
          '+nightly',
          'test',
          '-p',
          'beta',
          '--release',
          '--no-default-features',
          '-F',
          'io,net',
          '--',
          'f2',
        ]),
      ]),
    ).toEqual([
      'cargo',
      '+nightly',
      'test',
      '-p',
      'alpha',
      '-p',
      'beta',
      '--no-default-features',
      '--features',
      'io,net',
      '--profile',
      'release',
      '--no-fail-fast',
      '--',
      'f1',
      'f2',
    ]);
  });
});

describe('composeNextestBatchArgv', () => {
  it('composes one parenthesized or-joined filterset with unioned packages', () => {
    const leaderArgv = ['cargo', 'nextest', 'run', '-p', 'alpha', '-E', 'test(torn)'];
    const leader = intent(leaderArgv);
    const follower = intent(['cargo', 'nextest', 'run', '-p', 'beta', '-p', 'gamma']);

    expect(composeNextestBatchArgv(leaderArgv, leader, [follower])).toEqual([
      'cargo',
      'nextest',
      'run',
      '-p',
      'alpha',
      '-p',
      'beta',
      '-p',
      'gamma',
      '-E',
      '(test(torn)) or ((package(beta)) or (package(gamma)))',
      '--no-fail-fast',
    ]);
  });

  it('replaces inline filterset forms and keeps an existing --no-fail-fast', () => {
    const leaderArgv = ['cargo', 'nextest', 'run', '-p', 'alpha', '--filterset=test(a)', '--no-fail-fast'];
    const leader = intent(leaderArgv);
    const follower = intent(['cargo', 'nextest', 'run', '-p', 'beta']);

    expect(composeNextestBatchArgv(leaderArgv, leader, [follower])).toEqual([
      'cargo',
      'nextest',
      'run',
      '-p',
      'alpha',
      '--no-fail-fast',
      '-p',
      'beta',
      '-E',
      '(test(a)) or (package(beta))',
    ]);
  });
});
