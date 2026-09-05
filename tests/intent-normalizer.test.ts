import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'effect-rstest';

import {
  digestCargoEnvironment,
  normalizeCargoIntent,
  parseCargoArgv,
  splitShellStatements,
  splitShellWords,
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
      filterExpressions: [],
      manifestPath: 'nested/Cargo.toml',
      nextestCommand: null,
      noDefaultFeatures: false,
      envAssignments: {},
      envUnset: [],
      opaqueArguments: [],
      packages: ['alpha', 'beta'],
      passthrough: [],
      profile: 'ci',
      shellScript: null,
      subcommand: 'check',
      targetDir: 'build',
      targetTriple: 'x86_64-unknown-linux-gnu',
      targets: ['bin:tool', 'lib'],
      testFilters: [],
      toolchain: 'nightly',
      workspace: true,
    });
  });

  it('rejects a program path that is not cargo instead of treating it as the subcommand', () => {
    // A mis-resolved shim once submitted `/home/me/.cargo/bin/rustup test …`;
    // the daemon ran rustup with a cargo subcommand and logged the path as the
    // "subcommand" in every metrics view.
    expect(() => parseCargoArgv(['/home/me/.cargo/bin/rustup', 'test', '-p', 'foo'])).toThrow(
      /program must be cargo/u,
    );
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
    expect(parseCargoArgv(['cargo', 'build', '-r']).profile).toBe('release');
  });

  it('models install as release by default and honors its debug switch', () => {
    expect(parseCargoArgv(['cargo', 'install', 'cargo-nextest']).profile).toBe('release');
    expect(parseCargoArgv(['cargo', 'install', 'cargo-nextest', '--debug']).profile).toBe('dev');
  });

  it('records rustdoc target selection', () => {
    expect(parseCargoArgv(['cargo', 'test', '--doc']).targets).toEqual(['doc']);
  });

  it('captures trailing arguments after -- for every subcommand', () => {
    expect(parseCargoArgv(['cargo', 'rustc', '--', '-C', 'opt-level=3']).passthrough).toEqual([
      '-C',
      'opt-level=3',
    ]);
    expect(parseCargoArgv(['cargo', 'test', '--', '--ignored']).passthrough).toEqual([
      '--ignored',
    ]);
    expect(parseCargoArgv(['cargo', 'test', '--', 'torn_durable', 'verify_once']).passthrough).toEqual([
      'torn_durable',
      'verify_once',
    ]);
  });

  it('models positional test filters and --test targets structurally', () => {
    const parsed = parseCargoArgv([
      'cargo',
      'test',
      '-p',
      'tracedecay-graph-db',
      '--all-features',
      '--test',
      'durability_crash_contract',
      'torn_durable_store_is_quarantined',
    ]);
    expect(parsed.targets).toEqual(['test:durability_crash_contract']);
    expect(parsed.testFilters).toEqual(['torn_durable_store_is_quarantined']);
    expect(parsed.passthrough).toEqual([]);
    expect(parsed.opaqueArguments).toEqual([]);
  });

  it('models the nextest run command, filtersets, and positional filters', () => {
    const parsed = parseCargoArgv([
      'cargo',
      'nextest',
      'run',
      '-p',
      'graph',
      '-E',
      'test(verify_once)',
      'name_filter',
    ]);
    expect(parsed.subcommand).toBe('nextest');
    expect(parsed.nextestCommand).toBe('run');
    expect(parsed.filterExpressions).toEqual(['test(verify_once)']);
    expect(parsed.testFilters).toEqual(['name_filter']);
    expect(parsed.opaqueArguments).toEqual([]);
    expect(parseCargoArgv(['cargo', 'nextest', 'list']).nextestCommand).toBe('list');
  });

  it('consumes the value of unmodeled post-subcommand options instead of reading it as a filter', () => {
    // `cargo test -j 4 -- name` runs tests matching `name` on four threads;
    // `4` is never a test-name filter (#53).
    const parsed = parseCargoArgv([
      'cargo',
      'test',
      '-p',
      'alpha',
      '-j',
      '4',
      '--jobs',
      '8',
      '--color',
      'always',
      '--message-format',
      'short',
      '-Z',
      'unstable-options',
      '--config',
      'build.jobs=2',
      'real_filter',
    ]);
    expect(parsed.testFilters).toEqual(['real_filter']);
    expect(parsed.opaqueArguments).toEqual([
      '-j',
      '4',
      '--jobs',
      '8',
      '--color',
      'always',
      '--message-format',
      'short',
      '-Z',
      'unstable-options',
      '--config',
      'build.jobs=2',
    ]);
  });

  it('keeps inline-valued opaque options as one token', () => {
    const parsed = parseCargoArgv(['cargo', 'test', '--color=always', '-j=4', 'only_filter']);
    expect(parsed.opaqueArguments).toEqual(['--color=always', '-j=4']);
    expect(parsed.testFilters).toEqual(['only_filter']);
  });

  it('still models --target-dir, --manifest-path, and --features after the subcommand', () => {
    const parsed = parseCargoArgv([
      'cargo',
      'test',
      '--target-dir',
      'out',
      '--manifest-path',
      'crates/x/Cargo.toml',
      '--features',
      'net',
      'only_filter',
    ]);
    expect(parsed.targetDir).toBe('out');
    expect(parsed.manifestPath).toBe('crates/x/Cargo.toml');
    expect(parsed.features).toEqual(['net']);
    expect(parsed.testFilters).toEqual(['only_filter']);
    expect(parsed.opaqueArguments).toEqual([]);
  });

  it('consumes values of nextest-only options without stealing filters', () => {
    const parsed = parseCargoArgv([
      'cargo',
      'nextest',
      'run',
      '-p',
      'alpha',
      '--retries',
      '2',
      '--test-threads',
      '4',
      '-P',
      'ci',
      'only_filter',
    ]);
    expect(parsed.nextestCommand).toBe('run');
    expect(parsed.testFilters).toEqual(['only_filter']);
    expect(parsed.opaqueArguments).toEqual(['--retries', '2', '--test-threads', '4', '-P', 'ci']);
    // Outside nextest those spellings stay bare opaque tokens.
    expect(parseCargoArgv(['cargo', 'test', '--retries', 'name']).testFilters).toEqual(['name']);
  });

  it('rejects an unmodeled value-taking option without a value', () => {
    expect(() => parseCargoArgv(['cargo', 'test', '-j'])).toThrow('-j requires a value');
    expect(() => parseCargoArgv(['cargo', 'test', '--color', '--', 'f'])).toThrow(
      '--color requires a value',
    );
  });

  it('keeps -E opaque outside nextest without consuming a value', () => {
    const parsed = parseCargoArgv(['cargo', 'test', '-E', 'expr']);
    expect(parsed.opaqueArguments).toEqual(['-E']);
    expect(parsed.testFilters).toEqual(['expr']);
    expect(parsed.filterExpressions).toEqual([]);
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
    const directory = mkdtempSync(join(tmpdir(), 'cargo-hauler-intent-'));
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

  it('spells a not-yet-created target dir canonically before and after creation', () => {
    // Reproduces the darwin /var -> /private/var failure mode on any
    // platform: the target dir lives behind a symlink and does not exist
    // when the first request is normalized. Both submissions must agree on
    // one canonical spelling or lane keys and sameCompileSurface diverge.
    const directory = mkdtempSync(join(tmpdir(), 'cargo-hauler-intent-'));
    try {
      const real = join(directory, 'real');
      const linked = join(directory, 'linked');
      const workspace = join(real, 'workspace');
      mkdirSync(workspace, { recursive: true });
      symlinkSync(real, linked, 'dir');

      const options = {
        argv: ['cargo', 'check'],
        cwd: join(linked, 'workspace'),
        env: { CARGO_TARGET_DIR: join(linked, 'targets', 'shared') },
        workspaceRoot: join(linked, 'workspace'),
      } as const;

      const beforeCreation = normalizeCargoIntent(options);
      mkdirSync(join(real, 'targets', 'shared'), { recursive: true });
      const afterCreation = normalizeCargoIntent(options);

      expect(beforeCreation.targetDir).toBe(join(realpathSync(real), 'targets', 'shared'));
      expect(afterCreation.targetDir).toBe(beforeCreation.targetDir);
      expect(afterCreation.key).toBe(beforeCreation.key);
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

  it('separates test invocations by their harness filters in the normalized key', () => {
    const options = {
      cwd: '/work/repo',
      env: {},
      workspaceRoot: '/work/repo',
    } as const;

    const alpha = normalizeCargoIntent({
      ...options,
      argv: ['cargo', 'test', '-p', 'x', '--', 'alpha_only'],
    });
    const beta = normalizeCargoIntent({
      ...options,
      argv: ['cargo', 'test', '-p', 'x', '--', 'beta_only'],
    });
    const unfiltered = normalizeCargoIntent({
      ...options,
      argv: ['cargo', 'test', '-p', 'x'],
    });

    expect(alpha.key).not.toBe(beta.key);
    expect(alpha.key).not.toBe(unfiltered.key);
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

describe('program prefixes', () => {
  const normalize = (argv: readonly string[], env: Record<string, string> = {}) =>
    normalizeCargoIntent({ argv, cwd: '/tmp/ws', env, workspaceRoot: '/tmp/ws' });

  it('folds a leading env into the request environment and models the cargo behind it', () => {
    const parsed = parseCargoArgv(['env', 'FOO=1', 'HF_HUB_OFFLINE=1', 'cargo', 'test', '-p', 'alpha', '--lib']);
    expect(parsed.subcommand).toBe('test');
    expect(parsed.packages).toEqual(['alpha']);
    expect(parsed.targets).toEqual(['lib']);
    expect(parsed.envAssignments).toEqual({ FOO: '1', HF_HUB_OFFLINE: '1' });
    expect(parsed.opaqueArguments).toEqual([]);
    expect(parsed.shellScript).toBeNull();
    expect(parseCargoArgv(['/usr/bin/env', 'RUSTFLAGS=-Dwarnings', 'cargo', 'check']).subcommand).toBe('check');
  });

  it('applies env assignments and -u to the surface: target dir, digest, and identity', () => {
    const plain = normalize(['cargo', 'build', '-p', 'alpha']);
    const retargeted = normalize(['env', 'CARGO_TARGET_DIR=alt', 'cargo', 'build', '-p', 'alpha']);
    expect(retargeted.targetDir).toBe(join(realpathSync('/tmp'), 'ws', 'alt'));
    expect(retargeted.key).not.toBe(plain.key);

    const flagged = normalize(['env', 'RUSTFLAGS=-Dwarnings', 'cargo', 'build', '-p', 'alpha']);
    expect(flagged.envDigest).toBe(digestCargoEnvironment({ RUSTFLAGS: '-Dwarnings' }));
    expect(flagged.envDigest).not.toBe(plain.envDigest);

    const unset = normalize(['env', '-u', 'RUSTFLAGS', 'cargo', 'build', '-p', 'alpha'], {
      RUSTFLAGS: '-Dwarnings',
    });
    expect(unset.envDigest).toBe(plain.envDigest);
    expect(unset.envUnset).toEqual(['RUSTFLAGS']);

    // Assignments outside the compile-relevant set still separate intents:
    // a test may read them.
    const a = normalize(['env', 'TEST_BIN=/a', 'cargo', 'test', '-p', 'alpha']);
    const b = normalize(['env', 'TEST_BIN=/b', 'cargo', 'test', '-p', 'alpha']);
    expect(a.key).not.toBe(b.key);
    expect(a.key).toBe(normalize(['env', 'TEST_BIN=/a', 'cargo', 'test', '-p', 'alpha']).key);
  });

  it('keeps env -i opaque and refuses other env options or a non-cargo program', () => {
    expect(parseCargoArgv(['env', '-i', 'PATH=/x', 'cargo', 'check']).opaqueArguments).toEqual(['-i']);
    expect(() => parseCargoArgv(['env', '-C', '/x', 'cargo', 'check'])).toThrow(/unsupported env option/u);
    expect(() => parseCargoArgv(['env', 'FOO=1', 'make'])).toThrow(/program must be cargo, got make/u);
    expect(() => parseCargoArgv(['env', 'FOO=1'])).toThrow(/program must be cargo/u);
  });

  it('reads the single cargo statement of a bash -c script and marks it shell-wrapped', () => {
    const script = "source scripts/hotpath-rustflags.sh\nexport HOTPATH_REPORT=timing\ncargo bench --locked -p runtime-core --profile test --bench exact_sql -- --warm";
    const parsed = parseCargoArgv(['bash', '-lc', script]);
    expect(parsed.subcommand).toBe('bench');
    expect(parsed.packages).toEqual(['runtime-core']);
    expect(parsed.targets).toEqual(['bench:exact_sql']);
    expect(parsed.profile).toBe('test');
    expect(parsed.passthrough).toEqual(['--warm']);
    expect(parsed.shellScript).toBe(script);
    expect(parsed.opaqueArguments).toEqual(['bash', '-lc', script, '--locked']);

    const quoted = parseCargoArgv(['sh', '-c', 'FOO="a b" exec env BAR=1 cargo test -p alpha -- "name with space"']);
    expect(quoted.subcommand).toBe('test');
    expect(quoted.envAssignments).toEqual({ BAR: '1', FOO: 'a b' });
    expect(quoted.passthrough).toEqual(['name with space']);
  });

  it('keeps the shell as the subcommand when a script has no or several cargo statements', () => {
    const none = parseCargoArgv(['bash', '-c', 'echo hi && make']);
    expect(none.subcommand).toBe('bash');
    expect(none.shellScript).toBe('echo hi && make');
    const several = parseCargoArgv(['bash', '-c', 'cargo build -p a && cargo test -p a']);
    expect(several.subcommand).toBe('bash');
    expect(several.shellScript).toBe('cargo build -p a && cargo test -p a');
    // A shell run without -c is not a wrapper at all.
    expect(parseCargoArgv(['bash', 'script.sh']).subcommand).toBe('bash');
  });

  it('separates wrapped intents by script and by cargo tail', () => {
    const one = normalize(['bash', '-c', 'source a.sh; cargo test -p alpha']);
    const two = normalize(['bash', '-c', 'source b.sh; cargo test -p alpha']);
    const direct = normalize(['cargo', 'test', '-p', 'alpha']);
    expect(one.key).not.toBe(two.key);
    expect(one.key).not.toBe(direct.key);
    expect(one.subcommand).toBe('test');
    expect(one.targetDir).toBe(direct.targetDir);
  });
});

describe('shell statement helpers', () => {
  it('splits statements at operators outside quotes', () => {
    expect(splitShellStatements("a 'b;c' && d || e | f\ng & h; i")).toEqual([
      "a 'b;c'",
      'd',
      'e',
      'f',
      'g',
      'h',
      'i',
    ]);
  });

  it('splits words with quotes and escapes stripped', () => {
    expect(splitShellWords(`cargo test -- "a b" 'c d' e\\ f`)).toEqual(['cargo', 'test', '--', 'a b', 'c d', 'e f']);
  });
});
