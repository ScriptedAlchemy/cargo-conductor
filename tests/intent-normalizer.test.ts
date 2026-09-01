import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from '@rstest/core';

import {
  digestCargoEnvironment,
  normalizeCargoIntent,
  parseCargoArgv,
} from '../src/daemon/intent-normalizer.js';

describe('parseCargoArgv', () => {
  it('canonicalizes the cargo compile surface independently of argument order', () => {
    const left = parseCargoArgv([
      'cargo',
      '+nightly',
      'check',
      '--package',
      'beta',
      '--package=alpha',
      '--features',
      'zeta,alpha beta',
      '--lib',
      '--bin',
      'tool',
      '--target',
      'x86_64-unknown-linux-gnu',
      '--profile',
      'ci',
      '--workspace',
      '--exclude',
      'skip-me',
      '--target-dir',
      'build',
      '--manifest-path',
      'nested/Cargo.toml',
      '--',
      '--ignored-program-argument',
    ]);
    const right = parseCargoArgv([
      '+nightly',
      'check',
      '--manifest-path=nested/Cargo.toml',
      '--target-dir=build',
      '--exclude=skip-me',
      '--workspace',
      '--profile=ci',
      '--target=x86_64-unknown-linux-gnu',
      '--bin=tool',
      '--lib',
      '-F',
      'beta,zeta,alpha',
      '-p=alpha',
      '-p',
      'beta',
    ]);

    expect(left).toEqual(right);
    expect(left).toEqual({
      allFeatures: false,
      excludes: ['skip-me'],
      features: ['alpha', 'beta', 'zeta'],
      manifestPath: 'nested/Cargo.toml',
      noDefaultFeatures: false,
      opaqueArguments: [],
      packages: ['alpha', 'beta'],
      passthrough: [],
      profile: 'ci',
      subcommand: 'check',
      targetDir: 'build',
      targetTriple: 'x86_64-unknown-linux-gnu',
      targets: ['bin:tool', 'lib'],
      toolchain: 'nightly',
      workspace: true,
    });
  });

  it('accepts cargo global options before the subcommand', () => {
    expect(parseCargoArgv([
      '/usr/local/bin/cargo',
      '--locked',
      '--manifest-path',
      '../Cargo.toml',
      '--target-dir=../target',
      'test',
      '--tests',
      '--all-features',
      '--no-default-features',
      '--no-run',
    ])).toMatchObject({
      allFeatures: true,
      manifestPath: '../Cargo.toml',
      noDefaultFeatures: true,
      profile: 'test',
      subcommand: 'test',
      targetDir: '../target',
      targets: ['tests'],
    });
  });

  it('uses Cargo profile defaults when no profile flag is present', () => {
    expect(parseCargoArgv(['cargo', 'build']).profile).toBe('dev');
    expect(parseCargoArgv(['cargo', 'test']).profile).toBe('test');
    expect(parseCargoArgv(['cargo', 'bench']).profile).toBe('bench');
    expect(parseCargoArgv(['cargo', 'check', '--release']).profile).toBe('release');
  });

  it('models install as release by default and honors its debug switch', () => {
    expect(parseCargoArgv(['cargo', 'install', 'cargo-nextest']).profile).toBe('release');
    expect(parseCargoArgv(['cargo', 'install', 'cargo-nextest', '--debug']).profile).toBe('dev');
  });

  it('records rustdoc target selection', () => {
    expect(parseCargoArgv(['cargo', 'test', '--doc']).targets).toEqual(['doc']);
  });

  it('retains compiler passthrough only for cargo rustc', () => {
    expect(parseCargoArgv(['cargo', 'rustc', '--', '-C', 'opt-level=3']).passthrough).toEqual([
      '-C',
      'opt-level=3',
    ]);
    expect(parseCargoArgv(['cargo', 'test', '--', '--ignored']).passthrough).toEqual([]);
  });

  it('retains unmodeled arguments as an opaque ordered surface', () => {
    expect(parseCargoArgv([
      'cargo',
      'install',
      'cargo-nextest',
      '--git',
      'https://example.com/tools.git',
      '--rev',
      'abc123',
    ]).opaqueArguments).toEqual([
      'cargo-nextest',
      '--git',
      'https://example.com/tools.git',
      '--rev',
      'abc123',
    ]);
  });

  it('rejects an invocation without a subcommand', () => {
    expect(() => parseCargoArgv(['cargo'])).toThrow('subcommand');
  });

  it('rejects options whose required values are missing', () => {
    expect(() => parseCargoArgv(['cargo', 'check', '--package'])).toThrow(
      '--package requires a value',
    );
  });
});

describe('digestCargoEnvironment', () => {
  it('is stable across environment ordering and ignores unrelated session values', () => {
    const left = digestCargoEnvironment({
      CURSOR_SESSION_ID: 'first',
      RUSTC_WRAPPER: '/usr/local/bin/kache',
      RUSTFLAGS: '-C target-cpu=native',
    });
    const right = digestCargoEnvironment({
      RUSTFLAGS: '-C target-cpu=native',
      RUSTC_WRAPPER: '/usr/local/bin/kache',
      CURSOR_SESSION_ID: 'second',
    });

    expect(left).toBe(right);
    expect(left).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('changes when a compile-affecting environment variable changes', () => {
    expect(digestCargoEnvironment({ RUSTFLAGS: '-C opt-level=1' })).not.toBe(
      digestCargoEnvironment({ RUSTFLAGS: '-C opt-level=2' }),
    );
  });
});

describe('normalizeCargoIntent', () => {
  it('canonicalizes workspace and target-dir identity through symlinks', () => {
    const directory = mkdtempSync(join(tmpdir(), 'cargo-conductor-intent-'));
    try {
      const workspace = join(directory, 'workspace');
      const workspaceLink = join(directory, 'workspace-link');
      const cwd = join(workspace, 'crates', 'app');
      const target = join(workspace, 'shared-target');
      mkdirSync(cwd, { recursive: true });
      mkdirSync(target);
      symlinkSync(workspace, workspaceLink, 'dir');

      const intent = normalizeCargoIntent({
        argv: ['cargo', 'check', '--target-dir', '../../shared-target'],
        cwd,
        env: { RUSTFLAGS: '-Dwarnings' },
        workspaceRoot: workspaceLink,
      });

      expect(intent.workspaceRoot).toBe(realpathSync(workspace));
      expect(intent.targetDir).toBe(realpathSync(target));
      expect(intent.key).toMatch(/^[a-f0-9]{64}$/u);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it('uses CLI, environment, configured, then default target-dir precedence', () => {
    const base = {
      argv: ['cargo', 'check'],
      cwd: '/work/repo/member',
      env: {},
      workspaceRoot: '/work/repo',
    } as const;

    expect(normalizeCargoIntent(base).targetDir).toBe('/work/repo/target');
    expect(normalizeCargoIntent({
      ...base,
      configuredTargetDir: 'configured-target',
    }).targetDir).toBe('/work/repo/configured-target');
    expect(normalizeCargoIntent({
      ...base,
      configuredTargetDir: 'configured-target',
      env: { CARGO_TARGET_DIR: '../env-target' },
    }).targetDir).toBe('/work/repo/env-target');
    expect(normalizeCargoIntent({
      ...base,
      argv: ['cargo', 'check', '--target-dir', '../cli-target'],
      configuredTargetDir: 'configured-target',
      env: { CARGO_TARGET_DIR: '../env-target' },
    }).targetDir).toBe('/work/repo/cli-target');
  });

  it('uses Cargo build environment target and target-dir configuration', () => {
    const intent = normalizeCargoIntent({
      argv: ['cargo', 'check'],
      cwd: '/work/repo/member',
      env: {
        CARGO_BUILD_TARGET: 'aarch64-unknown-linux-gnu',
        CARGO_BUILD_TARGET_DIR: '../build-target',
      },
      workspaceRoot: '/work/repo',
    });

    expect(intent.targetTriple).toBe('aarch64-unknown-linux-gnu');
    expect(intent.targetDir).toBe('/work/repo/build-target');
  });

  it('produces one key for equivalent intents and separates incompatible surfaces', () => {
    const base = {
      cwd: '/work/repo',
      env: { RUSTFLAGS: '-Dwarnings' },
      workspaceRoot: '/work/repo',
    } as const;
    const first = normalizeCargoIntent({
      ...base,
      argv: ['cargo', '+nightly', 'check', '-p', 'b', '-p', 'a', '-F', 'x,y'],
    });
    const reordered = normalizeCargoIntent({
      ...base,
      argv: ['cargo', '+nightly', 'check', '--features=y,x', '-p=a', '-p=b'],
    });
    const differentToolchain = normalizeCargoIntent({
      ...base,
      argv: ['cargo', '+stable', 'check', '-p=a', '-p=b', '-F', 'x,y'],
    });
    const differentEnvironment = normalizeCargoIntent({
      ...base,
      argv: ['cargo', '+nightly', 'check', '-p=a', '-p=b', '-F', 'x,y'],
      env: { RUSTFLAGS: '-Awarnings' },
    });

    expect(first.key).toBe(reordered.key);
    expect(first.key).not.toBe(differentToolchain.key);
    expect(first.key).not.toBe(differentEnvironment.key);
  });

  it('separates cargo rustc compiler arguments in the normalized key', () => {
    const options = {
      cwd: '/work/repo',
      env: {},
      workspaceRoot: '/work/repo',
    } as const;

    const unoptimized = normalizeCargoIntent({
      ...options,
      argv: ['cargo', 'rustc', '--', '-C', 'opt-level=0'],
    });
    const optimized = normalizeCargoIntent({
      ...options,
      argv: ['cargo', 'rustc', '--', '-C', 'opt-level=3'],
    });

    expect(unoptimized.key).not.toBe(optimized.key);
  });

  it('separates unmodeled positional arguments in the normalized key', () => {
    const options = {
      cwd: '/work/repo',
      env: {},
      workspaceRoot: '/work/repo',
    } as const;

    const ripgrep = normalizeCargoIntent({
      ...options,
      argv: ['cargo', 'install', 'ripgrep'],
    });
    const nextest = normalizeCargoIntent({
      ...options,
      argv: ['cargo', 'install', 'cargo-nextest'],
    });

    expect(ripgrep.key).not.toBe(nextest.key);
  });

  it('uses RUSTUP_TOOLCHAIN only when argv has no explicit toolchain', () => {
    const options = {
      cwd: '/work/repo',
      env: { RUSTUP_TOOLCHAIN: 'stable' },
      workspaceRoot: '/work/repo',
    } as const;

    expect(normalizeCargoIntent({ ...options, argv: ['cargo', 'check'] }).toolchain).toBe('stable');
    expect(
      normalizeCargoIntent({ ...options, argv: ['cargo', '+nightly', 'check'] }).toolchain,
    ).toBe('nightly');
  });
});
