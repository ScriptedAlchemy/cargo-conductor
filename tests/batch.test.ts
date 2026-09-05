import { describe, expect, it } from 'effect-rstest';

import {
  batchCompatible,
  batchCompatibleFor,
  batchFailureOwned,
  batchKindFor,
  classifyTestTrailer,
  composeTestFoldArgv,
  compositePackages,
  compositeSelection,
  compositeTestFilters,
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

  it('merges compile intents whose `--` trailers are byte-equal (#86)', () => {
    const trailer = ['--', '-D', 'warnings'];
    expect(
      batchCompatible(
        intent(['cargo', 'clippy', '--all-targets', '-p', 'alpha', ...trailer]),
        intent(['cargo', 'clippy', '--all-targets', '-p', 'beta', ...trailer]),
      ),
    ).toBe(true);
    expect(
      batchKindFor(intent(['cargo', 'clippy', '-p', 'alpha', ...trailer])),
    ).toBe('compile');
  });

  it('refuses trailers that differ, are one-sided, or ride a different surface (#86)', () => {
    expect(
      batchCompatible(
        intent(['cargo', 'clippy', '-p', 'alpha', '--', '-D', 'warnings']),
        intent(['cargo', 'clippy', '-p', 'beta', '--', '-W', 'clippy::pedantic']),
      ),
    ).toBe(false);
    expect(
      batchCompatible(
        intent(['cargo', 'clippy', '-p', 'alpha', '--', '-D', 'warnings']),
        intent(['cargo', 'clippy', '-p', 'beta']),
      ),
    ).toBe(false);
    expect(
      batchCompatible(
        intent(['cargo', 'clippy', '-p', 'alpha']),
        intent(['cargo', 'clippy', '-p', 'beta', '--', '-D', 'warnings']),
      ),
    ).toBe(false);
    // The observed pair from #86: same trailer, but the composite would
    // lint more targets and features than each asked for.
    expect(
      batchCompatible(
        intent(['cargo', 'clippy', '--all-targets', '-p', 'alpha', '--', '-D', 'warnings']),
        intent([
          'cargo',
          'clippy',
          '-p',
          'beta',
          '--features',
          'test-helpers',
          '--tests',
          '--',
          '-D',
          'warnings',
        ]),
      ),
    ).toBe(false);
    expect(
      batchCompatible(
        intent(['cargo', 'clippy', '--all-targets', '-p', 'alpha', '--', '-D', 'warnings']),
        intent(['cargo', 'clippy', '--tests', '-p', 'beta', '--', '-D', 'warnings']),
      ),
    ).toBe(false);
  });
});

describe('withExtraPackages', () => {
  it('inserts -p flags before both the demux flag and the `--` trailer of a demuxed clippy', () => {
    expect(
      withExtraPackages(
        [
          'cargo',
          'clippy',
          '-p',
          'alpha',
          '--message-format=json-diagnostic-rendered-ansi',
          '--',
          '-D',
          'warnings',
        ],
        ['beta'],
      ),
    ).toEqual([
      'cargo',
      'clippy',
      '-p',
      'alpha',
      '-p',
      'beta',
      '--message-format=json-diagnostic-rendered-ansi',
      '--',
      '-D',
      'warnings',
    ]);
  });

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
    // `--lib` selects each package's own unit tests, like `--test NAME`
    // selects its own integration test (#87).
    expect(batchKindFor(intent(['cargo', 'test', '-p', 'alpha', '--lib']))).toBe('test');
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
    // Target narrowing other than --test / --lib.
    expect(batchKindFor(intent(['cargo', 'test', '-p', 'alpha', '--doc']))).toBe(null);
    expect(batchKindFor(intent(['cargo', 'test', '-p', 'alpha', '--bins']))).toBe(null);
    expect(batchKindFor(intent(['cargo', 'test', '-p', 'alpha', '--lib', '--bin', 'cli']))).toBe(
      null,
    );
    // Harness flags that change which tests run, or what the run produces,
    // neither lead nor join (#87) — even next to a foldable `--exact` (#97).
    expect(
      batchKindFor(intent(['cargo', 'test', '-p', 'alpha', '--', 'a_filter', '--skip', 'slow'])),
    ).toBe(null);
    expect(
      batchKindFor(
        intent(['cargo', 'test', '-p', 'alpha', '--', 'a::b', '--exact', '--skip', 'slow']),
      ),
    ).toBe(null);
    expect(
      batchKindFor(intent(['cargo', 'test', '-p', 'alpha', '--', 'a::b', '--exact', '--ignored'])),
    ).toBe(null);
    expect(batchKindFor(intent(['cargo', 'test', '-p', 'alpha', '--', '--ignored']))).toBe(null);
    expect(
      batchKindFor(intent(['cargo', 'test', '-p', 'alpha', '--', '--include-ignored'])),
    ).toBe(null);
    expect(batchKindFor(intent(['cargo', 'test', '-p', 'alpha', '--', '--list']))).toBe(null);
    expect(
      batchKindFor(intent(['cargo', 'test', '-p', 'alpha', '--', '--format', 'json'])),
    ).toBe(null);
    expect(
      batchKindFor(intent(['cargo', 'test', '-p', 'alpha', '--', '--logfile', 'out.log'])),
    ).toBe(null);
    expect(batchKindFor(intent(['cargo', 'test', '-p', 'alpha', '--', '-Z', 'unstable-options']))).toBe(
      null,
    );
  });

  it('lets a test run lead with foldable harness flags after `--` (#87)', () => {
    expect(
      batchKindFor(intent(['cargo', 'test', '-p', 'alpha', '--', 'a_filter', '--test-threads=4'])),
    ).toBe('test');
    expect(
      batchKindFor(intent(['cargo', 'test', '-p', 'alpha', '--', '--test-threads', '4', '--nocapture'])),
    ).toBe('test');
    expect(batchKindFor(intent(['cargo', 'test', '-p', 'alpha', '--', '-q']))).toBe('test');
    // `--exact` folds too: libtest applies it to each OR-ed filter (#97).
    expect(
      batchKindFor(intent(['cargo', 'test', '-p', 'alpha', '--', 'a::b', '--exact'])),
    ).toBe('test');
    expect(
      batchKindFor(
        intent(['cargo', 'test', '-p', 'alpha', '--test', 'suite', 'a::b', '--', '--exact', '--nocapture']),
      ),
    ).toBe('test');
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

  it('refuses test intents whose --test targets differ', () => {
    // The old superset composite (#53) ran every participant's targets for
    // every package, so a follower could fail on tests it never asked for.
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
  });

  it('folds filtered test runs across packages with a union of bare name filters (#87)', () => {
    expect(
      batchCompatibleFor(
        'test',
        intent(['cargo', 'test', '-p', 'alpha', 'f1']),
        intent(['cargo', 'test', '-p', 'beta', 'f2']),
      ),
    ).toBe(true);
    // The observed pair from #87, minus its shared --test-threads.
    expect(
      batchCompatibleFor(
        'test',
        intent(['cargo', 'test', '-p', 'alpha', '--lib', '--', 'f1', 'f2']),
        intent(['cargo', 'test', '-p', 'beta', '--lib', '--', 'f3', 'f4', 'f5', 'f6']),
      ),
    ).toBe(true);
    expect(
      batchCompatibleFor(
        'test',
        intent(['cargo', 'test', '-p', 'alpha', '--test', 't1', '--', 'f1', 'f2']),
        intent(['cargo', 'test', '-p', 'beta', '--test', 't1', '--', 'f3']),
      ),
    ).toBe(true);
    // Target selection still matches exactly.
    expect(
      batchCompatibleFor(
        'test',
        intent(['cargo', 'test', '-p', 'alpha', '--lib', '--', 'f1']),
        intent(['cargo', 'test', '-p', 'beta', '--', 'f2']),
      ),
    ).toBe(false);
    // A positional filter and the same name after `--` reach libtest the
    // same way; the union of filters is {f1} either way.
    expect(
      batchCompatibleFor(
        'test',
        intent(['cargo', 'test', '-p', 'alpha', 'f1']),
        intent(['cargo', 'test', '-p', 'beta', '--', 'f1']),
      ),
    ).toBe(true);
  });

  it('keeps the identical-selection rule for runs naming the same packages (#53)', () => {
    // Same package set, different filters: no compile is shared, and each
    // would run (and see) the other's tests in its own package.
    expect(
      batchCompatibleFor(
        'test',
        intent(['cargo', 'test', '-p', 'alpha', '--', 'alpha_only']),
        intent(['cargo', 'test', '-p', 'alpha', '--', 'beta_only']),
      ),
    ).toBe(false);
    expect(
      batchCompatibleFor(
        'test',
        intent(['cargo', 'test', '-p', 'alpha', '-p', 'beta', '--', 'f1']),
        intent(['cargo', 'test', '-p', 'beta', '-p', 'alpha', '--', 'f1', 'f2']),
      ),
    ).toBe(false);
    // Same selection in another spelling or order still folds (an identity
    // attach would have caught byte-equal argv earlier).
    expect(
      batchCompatibleFor(
        'test',
        intent(['cargo', 'test', '-p', 'alpha', 'f1', '--', 'f2']),
        intent(['cargo', 'test', '-p', 'alpha', '--', 'f2', 'f1']),
      ),
    ).toBe(true);
  });

  it('never folds an unfiltered test run with a filtered one', () => {
    // The unfiltered run asked for every test in its packages; any filter
    // would narrow it, and dropping the filter would widen the other.
    expect(
      batchCompatibleFor(
        'test',
        intent(['cargo', 'test', '-p', 'alpha', '--', 'f1']),
        intent(['cargo', 'test', '-p', 'beta']),
      ),
    ).toBe(false);
    expect(
      batchCompatibleFor(
        'test',
        intent(['cargo', 'test', '-p', 'alpha']),
        intent(['cargo', 'test', '-p', 'beta', 'f2']),
      ),
    ).toBe(false);
  });

  it('folds identical foldable harness flags and refuses mismatched ones (#87)', () => {
    expect(
      batchCompatibleFor(
        'test',
        intent(['cargo', 'test', '-p', 'alpha', '--', 'f1', '--test-threads=4']),
        intent(['cargo', 'test', '-p', 'beta', '--', 'f2', '--test-threads=4']),
      ),
    ).toBe(true);
    // Spelling does not matter: the set is compared in canonical form.
    expect(
      batchCompatibleFor(
        'test',
        intent(['cargo', 'test', '-p', 'alpha', '--', '--test-threads', '4', '-q', 'f1']),
        intent(['cargo', 'test', '-p', 'beta', '--', 'f2', '--quiet', '--test-threads=4']),
      ),
    ).toBe(true);
    expect(
      batchCompatibleFor(
        'test',
        intent(['cargo', 'test', '-p', 'alpha', '--', 'f1', '--test-threads=4']),
        intent(['cargo', 'test', '-p', 'beta', '--', 'f2', '--test-threads=2']),
      ),
    ).toBe(false);
    expect(
      batchCompatibleFor(
        'test',
        intent(['cargo', 'test', '-p', 'alpha', '--', 'f1', '--test-threads=4']),
        intent(['cargo', 'test', '-p', 'beta', '--', 'f2']),
      ),
    ).toBe(false);
    expect(
      batchCompatibleFor(
        'test',
        intent(['cargo', 'test', '-p', 'alpha', '--', 'f1', '--nocapture']),
        intent(['cargo', 'test', '-p', 'beta', '--', 'f2', '--nocapture', '--quiet']),
      ),
    ).toBe(false);
  });

  it('folds --exact runs on different packages when every participant asked for it (#97)', () => {
    // The pair from #97: libtest OR-s the filters and applies `--exact` to
    // each, so the composite runs precisely the union of both selections.
    expect(
      batchCompatibleFor(
        'test',
        intent(['cargo', 'test', '-p', 'alpha', '--test', 'suite', 'x::y', '--', '--exact']),
        intent(['cargo', 'test', '-p', 'beta', '--test', 'suite', 'z::w', '--', '--exact']),
      ),
    ).toBe(true);
    expect(
      batchCompatibleFor(
        'test',
        intent(['cargo', 'test', '-p', 'alpha', '--', 'x::y', '--exact']),
        intent(['cargo', 'test', '-p', 'beta', '--', 'z::w', '--exact']),
      ),
    ).toBe(true);
    // The single-test shape agents emit: `--exact --nocapture`, in any order.
    expect(
      batchCompatibleFor(
        'test',
        intent(['cargo', 'test', '-p', 'alpha', '--lib', '--', 'x::y', '--exact', '--nocapture']),
        intent(['cargo', 'test', '-p', 'beta', '--lib', '--', '--nocapture', 'z::w', '--exact']),
      ),
    ).toBe(true);
    expect(
      batchCompatibleFor(
        'test',
        intent(['cargo', 'test', '-p', 'alpha', '--', 'x::y', '--exact', '--test-threads=4']),
        intent(['cargo', 'test', '-p', 'beta', '--', 'z::w', '--test-threads', '4', '--exact']),
      ),
    ).toBe(true);
    // Same package set: the identical-selection rule (#53) still applies.
    expect(
      batchCompatibleFor(
        'test',
        intent(['cargo', 'test', '-p', 'alpha', '--', 'x::y', '--exact']),
        intent(['cargo', 'test', '-p', 'alpha', '--', 'z::w', '--exact']),
      ),
    ).toBe(false);
    expect(
      batchCompatibleFor(
        'test',
        intent(['cargo', 'test', '-p', 'alpha', 'x::y', '--', '--exact']),
        intent(['cargo', 'test', '-p', 'alpha', '--', '--exact', 'x::y']),
      ),
    ).toBe(true);
    // Filtered never folds with unfiltered, `--exact` or not.
    expect(
      batchCompatibleFor(
        'test',
        intent(['cargo', 'test', '-p', 'alpha', '--', '--exact']),
        intent(['cargo', 'test', '-p', 'beta', '--', 'z::w', '--exact']),
      ),
    ).toBe(false);
    // Target selection still has to match.
    expect(
      batchCompatibleFor(
        'test',
        intent(['cargo', 'test', '-p', 'alpha', '--test', 'suite', '--', 'x::y', '--exact']),
        intent(['cargo', 'test', '-p', 'beta', '--lib', '--', 'z::w', '--exact']),
      ),
    ).toBe(false);
  });

  it('never mixes exact and substring matching, as leader or follower (#97)', () => {
    // A shared `--exact` would make the substring side match whole names
    // only; dropping it would make the exact side match substrings.
    expect(
      batchCompatibleFor(
        'test',
        intent(['cargo', 'test', '-p', 'alpha', '--', 'f1']),
        intent(['cargo', 'test', '-p', 'beta', '--', 'f1', '--exact']),
      ),
    ).toBe(false);
    expect(
      batchCompatibleFor(
        'test',
        intent(['cargo', 'test', '-p', 'alpha', '--', 'f1', '--exact']),
        intent(['cargo', 'test', '-p', 'beta', '--', 'f1']),
      ),
    ).toBe(false);
    // The rest of the harness set must match too.
    expect(
      batchCompatibleFor(
        'test',
        intent(['cargo', 'test', '-p', 'alpha', '--', 'x::y', '--exact', '--nocapture']),
        intent(['cargo', 'test', '-p', 'beta', '--', 'z::w', '--exact']),
      ),
    ).toBe(false);
    // Other harness flags still keep a run out, `--exact` beside them or not.
    expect(
      batchCompatibleFor(
        'test',
        intent(['cargo', 'test', '-p', 'alpha', '--', 'x::y', '--exact']),
        intent(['cargo', 'test', '-p', 'beta', '--', 'z::w', '--exact', '--skip', 'slow']),
      ),
    ).toBe(false);
    expect(
      batchCompatibleFor(
        'test',
        intent(['cargo', 'test', '-p', 'alpha', '--', 'x::y', '--exact']),
        intent(['cargo', 'test', '-p', 'beta', '--', 'z::w', '--exact', '--ignored']),
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

describe('compositeTestFilters', () => {
  it('unions positional and post-`--` name filters, leader first, without duplicates', () => {
    expect(
      compositeTestFilters(intent(['cargo', 'test', '-p', 'alpha', 'f1']), [
        intent(['cargo', 'test', '-p', 'beta', '--', 'f2', 'f1']),
        intent(['cargo', 'test', '-p', 'gamma', '--', 'f3', '--test-threads=4']),
      ]),
    ).toEqual(['f1', 'f2', 'f3']);
    expect(
      compositeTestFilters(intent(['cargo', 'nextest', 'run', '-p', 'alpha']), [
        intent(['cargo', 'nextest', 'run', '-p', 'beta']),
      ]),
    ).toEqual([]);
  });
});

describe('batchFailureOwned', () => {
  it('lets a test participant own the failure only when it named every composite package', () => {
    const leader = intent(['cargo', 'test', '-p', 'alpha', '--', 'f1']);
    const follower = intent(['cargo', 'test', '-p', 'beta', '--', 'f1']);
    const wide = intent(['cargo', 'test', '-p', 'alpha', '-p', 'beta', '--', 'f1']);
    const composite = compositeSelection(leader, [follower, wide]);
    // beta's tests may have passed while alpha's failed: not beta's failure.
    expect(batchFailureOwned(leader, composite, follower)).toBe(false);
    // The wide participant asked for exactly what the composite ran.
    expect(batchFailureOwned(leader, composite, wide)).toBe(true);
  });

  it('also requires the participant to have asked for every filter the composite ran (#87)', () => {
    const leader = intent(['cargo', 'test', '-p', 'alpha', '--', 'f1']);
    const follower = intent(['cargo', 'test', '-p', 'alpha', '-p', 'beta', '--', 'f2']);
    const composite = compositeSelection(leader, [follower]);
    expect(composite).toEqual({ packages: ['alpha', 'beta'], filters: ['f1', 'f2'] });
    // Every package, but f1's tests may be the failing ones: not f2's failure.
    expect(batchFailureOwned(leader, composite, follower)).toBe(false);
    expect(
      batchFailureOwned(
        leader,
        composite,
        intent(['cargo', 'test', '-p', 'alpha', '-p', 'beta', 'f2', '--', 'f1']),
      ),
    ).toBe(true);
  });

  it('holds for --exact composites: every package and every exact filter (#97)', () => {
    const leader = intent(['cargo', 'test', '-p', 'alpha', '--', 'x::y', '--exact']);
    const follower = intent(['cargo', 'test', '-p', 'beta', '--', 'z::w', '--exact']);
    const wide = intent(['cargo', 'test', '-p', 'alpha', '-p', 'beta', '--', 'x::y', 'z::w', '--exact']);
    const composite = compositeSelection(leader, [follower, wide]);
    expect(composite).toEqual({ packages: ['alpha', 'beta'], filters: ['x::y', 'z::w'] });
    // beta's z::w may have passed while alpha's x::y failed: reruns alone.
    expect(batchFailureOwned(leader, composite, follower)).toBe(false);
    // Every package but not every filter: x::y may be the failing one.
    expect(
      batchFailureOwned(
        leader,
        composite,
        intent(['cargo', 'test', '-p', 'alpha', '-p', 'beta', '--', 'z::w', '--exact']),
      ),
    ).toBe(false);
    expect(batchFailureOwned(leader, composite, wide)).toBe(true);
  });

  it('applies to nextest composites and never to compile batches', () => {
    const nextestLeader = intent(['cargo', 'nextest', 'run', '-p', 'alpha']);
    const nextestFollower = intent(['cargo', 'nextest', 'run', '-p', 'beta']);
    const nextestComposite = compositeSelection(nextestLeader, [nextestFollower]);
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
        compositeSelection(checkLeader, [checkFollower]),
        checkFollower,
      ),
    ).toBe(false);
  });
});

describe('classifyTestTrailer', () => {
  it('splits bare filters from foldable harness flags in canonical form', () => {
    expect(classifyTestTrailer([])).toEqual({ filters: [], harness: [] });
    expect(classifyTestTrailer(['f1', 'f2'])).toEqual({ filters: ['f1', 'f2'], harness: [] });
    expect(
      classifyTestTrailer(['f1', '--test-threads=4', 'f2', '--nocapture', '-q']),
    ).toEqual({
      filters: ['f1', 'f2'],
      harness: ['--nocapture', '--quiet', '--test-threads=4'],
    });
    // Two-token --test-threads and --quiet spell the same set.
    expect(classifyTestTrailer(['--quiet', '--test-threads', '4', 'f1'])).toEqual({
      filters: ['f1'],
      harness: ['--quiet', '--test-threads=4'],
    });
  });

  it('accepts --exact as a foldable harness flag, alone or with the others (#97)', () => {
    expect(classifyTestTrailer(['x::y', '--exact'])).toEqual({
      filters: ['x::y'],
      harness: ['--exact'],
    });
    expect(classifyTestTrailer(['--exact'])).toEqual({ filters: [], harness: ['--exact'] });
    expect(classifyTestTrailer(['x::y', '--exact', '--nocapture'])).toEqual({
      filters: ['x::y'],
      harness: ['--exact', '--nocapture'],
    });
    expect(classifyTestTrailer(['--nocapture', 'x::y', '--exact', 'z::w'])).toEqual({
      filters: ['x::y', 'z::w'],
      harness: ['--exact', '--nocapture'],
    });
    expect(classifyTestTrailer(['x::y', '--exact', '--test-threads=4'])).toEqual({
      filters: ['x::y'],
      harness: ['--exact', '--test-threads=4'],
    });
    expect(classifyTestTrailer(['--test-threads', '4', '--exact', 'x::y', '-q'])).toEqual({
      filters: ['x::y'],
      harness: ['--exact', '--quiet', '--test-threads=4'],
    });
  });

  it('rejects flags that change which tests run or what the run produces', () => {
    for (const trailer of [
      ['--skip', 'slow'],
      ['x::y', '--exact', '--skip', 'slow'],
      ['x::y', '--exact', '--ignored'],
      ['x::y', '--exact', '--include-ignored'],
      ['x::y', '--exact', '--list'],
      ['x::y', '--exact', '--format', 'json'],
      ['x::y', '--exact', '--logfile', 'out.log'],
      // libtest's --exact takes no value.
      ['x::y', '--exact=true'],
      ['x::y', '--exact='],
      ['--ignored'],
      ['--include-ignored'],
      ['--list'],
      ['--format', 'json'],
      ['--format=terse'],
      ['--logfile', 'out.log'],
      ['--report-time'],
      ['--show-output'],
      ['-Z', 'unstable-options'],
      ['--color', 'never'],
      ['--test-threads'],
      ['--test-threads', '--nocapture'],
      ['--test-threads='],
      ['--nocapture=1'],
    ]) {
      expect(classifyTestTrailer(trailer)).toBeNull();
    }
  });
});

describe('composeTestFoldArgv', () => {
  it('unions the followers\' filters behind the leader\'s, ahead of its harness flags (#87)', () => {
    const leader = intent(['cargo', 'test', '-p', 'alpha', '--lib', '--', 'f1', '--test-threads=4']);
    expect(
      composeTestFoldArgv(
        ['cargo', 'test', '-p', 'alpha', '--lib', '--', 'f1', '--test-threads=4'],
        leader,
        [
          intent(['cargo', 'test', '-p', 'beta', '--lib', '--', 'f2', 'f1', '--test-threads=4']),
          intent(['cargo', 'test', '-p', 'gamma', '--lib', '--', 'f3', '--test-threads=4']),
        ],
      ),
    ).toEqual([
      'cargo',
      'test',
      '-p',
      'alpha',
      '--lib',
      '-p',
      'beta',
      '-p',
      'gamma',
      '--no-fail-fast',
      '--',
      'f1',
      'f2',
      'f3',
      '--test-threads=4',
    ]);
    // A two-token --test-threads keeps its value; flags before the leader's
    // filters stay where they were.
    const spaced = ['cargo', 'test', '-p', 'alpha', '--', '--nocapture', 'f1', '--test-threads', '4'];
    expect(
      composeTestFoldArgv(spaced, intent(spaced), [
        intent(['cargo', 'test', '-p', 'beta', '--', 'f2', '--nocapture', '--test-threads=4']),
      ]),
    ).toEqual([
      'cargo',
      'test',
      '-p',
      'alpha',
      '-p',
      'beta',
      '--no-fail-fast',
      '--',
      '--nocapture',
      'f1',
      'f2',
      '--test-threads',
      '4',
    ]);
  });

  it('carries --exact once, after the unioned filters (#97)', () => {
    const leaderArgv = ['cargo', 'test', '-p', 'alpha', '--test', 'suite', '--', 'x::y', '--exact'];
    expect(
      composeTestFoldArgv(leaderArgv, intent(leaderArgv), [
        intent(['cargo', 'test', '-p', 'beta', '--test', 'suite', '--', 'z::w', '--exact']),
      ]),
    ).toEqual([
      'cargo',
      'test',
      '-p',
      'alpha',
      '--test',
      'suite',
      '-p',
      'beta',
      '--no-fail-fast',
      '--',
      'x::y',
      'z::w',
      '--exact',
    ]);
    // The pair from #97, filters positional: the leader's trailer holds only
    // `--exact`, so the follower's filter opens it.
    const positional = ['cargo', 'test', '-p', 'alpha', '--test', 'suite', 'x::y', '--', '--exact'];
    expect(
      composeTestFoldArgv(positional, intent(positional), [
        intent(['cargo', 'test', '-p', 'beta', '--test', 'suite', 'z::w', '--', '--exact']),
      ]),
    ).toEqual([
      'cargo',
      'test',
      '-p',
      'alpha',
      '--test',
      'suite',
      'x::y',
      '-p',
      'beta',
      '--no-fail-fast',
      '--',
      'z::w',
      '--exact',
    ]);
    // `--exact --nocapture`, three participants, one shared filter: the
    // flags still appear once each.
    const single = ['cargo', 'test', '-p', 'alpha', '--', 'x::y', '--exact', '--nocapture'];
    const composite = composeTestFoldArgv(single, intent(single), [
      intent(['cargo', 'test', '-p', 'beta', '--', 'z::w', '--exact', '--nocapture']),
      intent(['cargo', 'test', '-p', 'gamma', '--', '--nocapture', 'x::y', '--exact']),
    ]);
    expect(composite).toEqual([
      'cargo',
      'test',
      '-p',
      'alpha',
      '-p',
      'beta',
      '-p',
      'gamma',
      '--no-fail-fast',
      '--',
      'x::y',
      'z::w',
      '--exact',
      '--nocapture',
    ]);
    expect(composite.filter((argument) => argument === '--exact')).toHaveLength(1);
  });

  it('opens a `--` trailer for follower filters when the leader has none', () => {
    const leader = intent(['cargo', 'test', '-p', 'alpha', 'f1']);
    expect(
      composeTestFoldArgv(['cargo', 'test', '-p', 'alpha', 'f1'], leader, [
        intent(['cargo', 'test', '-p', 'beta', '--', 'f2']),
        // f1 already reaches libtest through the leader's positional.
        intent(['cargo', 'test', '-p', 'gamma', '--', 'f1']),
      ]),
    ).toEqual([
      'cargo',
      'test',
      '-p',
      'alpha',
      'f1',
      '-p',
      'beta',
      '-p',
      'gamma',
      '--no-fail-fast',
      '--',
      'f2',
    ]);
  });

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

    expect(composeTestFoldArgv(leaderArgv, intent(leaderArgv), [follower])).toEqual([
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
      composeTestFoldArgv(leaderArgv, intent(leaderArgv), [
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
      composeTestFoldArgv(leaderArgv, intent(leaderArgv), [
        intent(['cargo', 'test', '-p', 'alpha', '-p', 'beta']),
      ]),
    ).toEqual(['cargo', 'test', '-p', 'alpha', '--no-fail-fast', '-p', 'beta']);
  });

  it('extends a nextest run the same way, keeping the shared filterset once', () => {
    const leaderArgv = ['cargo', 'nextest', 'run', '-p', 'alpha', '-E', 'test(torn)'];
    expect(
      composeTestFoldArgv(leaderArgv, intent(leaderArgv), [
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
