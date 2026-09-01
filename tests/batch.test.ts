import { describe, expect, it } from '@rstest/core';

import {
  batchCompatible,
  extraPackagesFor,
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
