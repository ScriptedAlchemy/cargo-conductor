import { describe, expect, it } from 'effect-rstest';

import {
  batchCompatible,
  batchCompatibleFor,
  batchFailureOwned,
  batchKindFor,
  composeTestFoldArgv,
  compositePackages,
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
  it('folds same-surface test intents with identical selections across packages', () => {
    expect(
      batchCompatibleFor(
        'test',
        intent(['cargo', 'test', '-p', 'alpha', '--all-features', '--test', 't1', 'f1']),
        intent(['cargo', 'test', '-p', 'beta', '--all-features', '--test', 't1', 'f1']),
      ),
    ).toBe(true);
    expect(
      batchCompatibleFor(
        'test',
        intent(['cargo', 'test', '-p', 'alpha', '--', 'f1', 'f2']),
        intent(['cargo', 'test', '-p', 'beta', '-p', 'gamma', '--', 'f1', 'f2']),
      ),
    ).toBe(true);
    expect(
      batchCompatibleFor(
        'test',
        intent(['cargo', 'test', '-p', 'alpha']),
        intent(['cargo', 'test', '-p', 'beta', '--no-fail-fast']),
      ),
    ).toBe(true);
    expect(
      batchCompatibleFor(
        'nextest',
        intent(['cargo', 'nextest', 'run', '-p', 'alpha', '-E', 'test(x)']),
        intent(['cargo', 'nextest', 'run', '-p', 'beta', '-E', 'test(x)']),
      ),
    ).toBe(true);
    expect(
      batchCompatibleFor(
        'nextest',
        intent(['cargo', 'nextest', 'run', '-p', 'alpha']),
        intent(['cargo', 'nextest', 'run', '-p', 'beta']),
      ),
    ).toBe(true);
  });

  it('refuses test intents whose --test targets, name filters, or trailing arguments differ', () => {
    // The old superset composite (#53) ran every participant's targets and
    // filters for every package, so a follower could fail on tests it never
    // asked for. Only the package set may differ now.
    expect(
      batchCompatibleFor(
        'test',
        intent(['cargo', 'test', '-p', 'alpha', '--test', 't1', 'f1']),
        intent(['cargo', 'test', '-p', 'beta', '--test', 't2', 'f1']),
      ),
    ).toBe(false);
    expect(
      batchCompatibleFor(
        'test',
        intent(['cargo', 'test', '-p', 'alpha', '--test', 't1']),
        intent(['cargo', 'test', '-p', 'beta']),
      ),
    ).toBe(false);
    expect(
      batchCompatibleFor(
        'test',
        intent(['cargo', 'test', '-p', 'alpha', 'f1']),
        intent(['cargo', 'test', '-p', 'beta', 'f2']),
      ),
    ).toBe(false);
    expect(
      batchCompatibleFor(
        'test',
        intent(['cargo', 'test', '-p', 'alpha', '--', 'f1']),
        intent(['cargo', 'test', '-p', 'beta']),
      ),
    ).toBe(false);
    // A positional filter and the same name after `--` reach libtest the
    // same way, but the composite is the leader's argv, so they must match
    // byte for byte.
    expect(
      batchCompatibleFor(
        'test',
        intent(['cargo', 'test', '-p', 'alpha', 'f1']),
        intent(['cargo', 'test', '-p', 'beta', '--', 'f1']),
      ),
    ).toBe(false);
  });

  it('refuses nextest intents whose filtersets differ', () => {
    expect(
      batchCompatibleFor(
        'nextest',
        intent(['cargo', 'nextest', 'run', '-p', 'alpha', '-E', 'test(x)']),
        intent(['cargo', 'nextest', 'run', '-p', 'beta']),
      ),
    ).toBe(false);
    expect(
      batchCompatibleFor(
        'nextest',
        intent(['cargo', 'nextest', 'run', '-p', 'alpha', '-E', 'test(x)']),
        intent(['cargo', 'nextest', 'run', '-p', 'beta', '-E', 'test(y)']),
      ),
    ).toBe(false);
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

describe('compositePackages', () => {
  it('unions the leader and every folded participant without duplicates', () => {
    expect(
      compositePackages(intent(['cargo', 'test', '-p', 'alpha']), [
        intent(['cargo', 'test', '-p', 'beta', '-p', 'alpha']),
        intent(['cargo', 'test', '-p', 'gamma']),
      ]),
    ).toEqual(['alpha', 'beta', 'gamma']);
  });
});

describe('batchFailureOwned', () => {
  it('lets a test participant own the failure only when it named every composite package', () => {
    const leader = intent(['cargo', 'test', '-p', 'alpha', '--', 'f1']);
    const follower = intent(['cargo', 'test', '-p', 'beta', '--', 'f1']);
    const wide = intent(['cargo', 'test', '-p', 'alpha', '-p', 'beta', '--', 'f1']);
    const composite = compositePackages(leader, [follower, wide]);
    // beta's tests may have passed while alpha's failed: not beta's failure.
    expect(batchFailureOwned(leader, composite, follower)).toBe(false);
    // The wide participant asked for exactly what the composite ran.
    expect(batchFailureOwned(leader, composite, wide)).toBe(true);
  });

  it('applies to nextest composites and never to compile batches', () => {
    const nextestLeader = intent(['cargo', 'nextest', 'run', '-p', 'alpha']);
    const nextestFollower = intent(['cargo', 'nextest', 'run', '-p', 'beta']);
    const nextestComposite = compositePackages(nextestLeader, [nextestFollower]);
    expect(batchFailureOwned(nextestLeader, nextestComposite, nextestFollower)).toBe(false);
    expect(
      batchFailureOwned(
        nextestLeader,
        nextestComposite,
        intent(['cargo', 'nextest', 'run', '-p', 'alpha', '-p', 'beta']),
      ),
    ).toBe(true);

    const checkLeader = intent(['cargo', 'check', '-p', 'alpha']);
    const checkFollower = intent(['cargo', 'check', '-p', 'alpha', '-p', 'beta']);
    expect(
      batchFailureOwned(
        checkLeader,
        compositePackages(checkLeader, [checkFollower]),
        checkFollower,
      ),
    ).toBe(false);
  });
});

describe('composeTestFoldArgv', () => {
  it('adds the followers\' packages and --no-fail-fast to the leader argv', () => {
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
    const follower = intent([
      'cargo',
      'test',
      '-p',
      'tracedecay-store',
      '--all-features',
      '--test',
      'durability_crash_contract',
      'torn_durable_store_is_quarantined_and_rebuilt',
    ]);

    expect(composeTestFoldArgv(leaderArgv, [follower])).toEqual([
      'cargo',
      'test',
      '-p',
      'tracedecay-graph-db',
      '--all-features',
      '--test',
      'durability_crash_contract',
      'torn_durable_store_is_quarantined_and_rebuilt',
      '-p',
      'tracedecay-store',
      '--no-fail-fast',
    ]);
  });

  it('keeps the leader\'s trailing harness arguments after the added flags', () => {
    const leaderArgv = ['cargo', '+nightly', 'test', '-p', 'alpha', '--release', '--', 'f1', 'f2'];
    expect(
      composeTestFoldArgv(leaderArgv, [
        intent(['cargo', '+nightly', 'test', '-p', 'beta', '-p', 'gamma', '--release', '--', 'f1', 'f2']),
      ]),
    ).toEqual([
      'cargo',
      '+nightly',
      'test',
      '-p',
      'alpha',
      '--release',
      '-p',
      'beta',
      '-p',
      'gamma',
      '--no-fail-fast',
      '--',
      'f1',
      'f2',
    ]);
  });

  it('does not duplicate packages or an existing --no-fail-fast', () => {
    const leaderArgv = ['cargo', 'test', '-p', 'alpha', '--no-fail-fast'];
    expect(
      composeTestFoldArgv(leaderArgv, [intent(['cargo', 'test', '-p', 'alpha', '-p', 'beta'])]),
    ).toEqual(['cargo', 'test', '-p', 'alpha', '--no-fail-fast', '-p', 'beta']);
  });

  it('extends a nextest run the same way, keeping the shared filterset once', () => {
    const leaderArgv = ['cargo', 'nextest', 'run', '-p', 'alpha', '-E', 'test(torn)'];
    expect(
      composeTestFoldArgv(leaderArgv, [
        intent(['cargo', 'nextest', 'run', '-p', 'beta', '-p', 'gamma', '-E', 'test(torn)']),
      ]),
    ).toEqual([
      'cargo',
      'nextest',
      'run',
      '-p',
      'alpha',
      '-E',
      'test(torn)',
      '-p',
      'beta',
      '-p',
      'gamma',
      '--no-fail-fast',
    ]);
  });
});
