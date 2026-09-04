import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

import { defaultCargoProfile, optionParts } from '../lib/argv.js';
import { isRelevantCargoEnvironmentVariable } from '../lib/cargo-env.js';

export interface ParsedCargoArgv {
  readonly allFeatures: boolean;
  readonly excludes: readonly string[];
  readonly features: readonly string[];
  /** nextest filterset expressions (`-E`/`--filterset`/`--filter-expr`). */
  readonly filterExpressions: readonly string[];
  readonly manifestPath: string | null;
  /** First positional after `nextest` (e.g. `run`, `list`); null elsewhere. */
  readonly nextestCommand: string | null;
  readonly noDefaultFeatures: boolean;
  readonly opaqueArguments: readonly string[];
  readonly packages: readonly string[];
  /** Arguments after `--`, forwarded to rustc/libtest/the spawned program. */
  readonly passthrough: readonly string[];
  readonly profile: string;
  readonly subcommand: string;
  readonly targetDir: string | null;
  readonly targetTriple: string | null;
  readonly targets: readonly string[];
  /** Positional test-name filters (`cargo test <NAME>`, nextest run filters). */
  readonly testFilters: readonly string[];
  readonly toolchain: string | null;
  readonly workspace: boolean;
}

export interface NormalizeCargoIntentOptions {
  readonly argv: readonly string[];
  readonly configuredTargetDir?: string;
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly workspaceRoot: string;
}

export type NormalizedCargoIntent = Omit<ParsedCargoArgv, 'manifestPath' | 'targetDir' | 'toolchain'> & {
  readonly cwd: string;
  readonly envDigest: string;
  readonly key: string;
  readonly manifestPath: string | null;
  readonly targetDir: string;
  readonly toolchain: string;
  readonly workspaceRoot: string;
};

const sortedUnique = (values: readonly string[]): string[] =>
  [...new Set(values)].sort((left, right) => left.localeCompare(right));

const splitFeatures = (value: string): string[] =>
  value.split(/[,\s]+/u).filter((feature) => feature.length > 0);

export const cargoExecutablePattern = /(?:^|[/\\])cargo(?:\.exe)?$/u;

/** Subcommands whose bare positional arguments are test-name filters. */
const testFilterSubcommands = new Set(['bench', 'nextest', 'test']);
const globalOptionsWithValues = new Set([
  '--color',
  '--config',
  '--explain',
  '--jobs',
  '-j',
  '-Z',
]);

/**
 * Post-subcommand cargo options the intent does not model but which take a
 * value. The pair stays opaque (it still disqualifies attaching and
 * batching), but the value is consumed with its option so `cargo test -j 4
 * name` never reads `4` as a test-name filter.
 */
const opaqueOptionsWithValues = new Set([
  '--color',
  '--config',
  '--jobs',
  '--message-format',
  '-j',
  '-Z',
]);

/** Value-taking `cargo nextest run` options, meaningful only under nextest. */
const nextestOpaqueOptionsWithValues = new Set([
  '--archive-file',
  '--build-jobs',
  '--cargo-profile',
  '--config-file',
  '--extract-to',
  '--failure-output',
  '--final-status-level',
  '--message-format-version',
  '--partition',
  '--retries',
  '--run-ignored',
  '--status-level',
  '--success-output',
  '--test-threads',
  '--tool-config-file',
  '--workspace-remap',
  '-P',
]);

const opaqueOptionTakesValue = (subcommand: string, option: string): boolean =>
  opaqueOptionsWithValues.has(option) ||
  (subcommand === 'nextest' && nextestOpaqueOptionsWithValues.has(option));

const affectsCompilation = isRelevantCargoEnvironmentVariable;

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

/**
 * One canonical spelling per path, whether or not it exists yet. A target
 * dir is usually created only when cargo first runs, so canonicalizing the
 * leaf alone would spell the same path two ways across submissions (on
 * macOS `/var/folders/...` before creation, `/private/var/folders/...`
 * after) and break lane keys and `sameCompileSurface`. When the full path
 * cannot be realpathed, canonicalize the nearest existing ancestor and
 * re-append the missing segments.
 */
const canonicalPath = (path: string): string => {
  const absolutePath = resolve(path);
  let current = absolutePath;
  const pending: string[] = [];
  for (;;) {
    try {
      const canonicalAncestor = realpathSync(current);
      return pending.length === 0 ? canonicalAncestor : join(canonicalAncestor, ...pending);
    } catch {
      const parent = dirname(current);
      if (parent === current) {
        return absolutePath;
      }
      pending.unshift(basename(current));
      current = parent;
    }
  }
};

const resolveFrom = (base: string, path: string): string =>
  canonicalPath(isAbsolute(path) ? path : resolve(base, path));

export const digestCargoEnvironment = (
  env: Readonly<Record<string, string | undefined>>,
): string => {
  const entries = Object.entries(env)
    .filter((entry): entry is [string, string] => entry[1] !== undefined && affectsCompilation(entry[0]))
    .sort(([left], [right]) => left.localeCompare(right));
  const hash = createHash('sha256');
  hash.update('cargo-hauler-env-v1\0');
  for (const [name, value] of entries) {
    hash.update(name);
    hash.update('\0');
    hash.update(value);
    hash.update('\0');
  }
  return hash.digest('hex');
};

export const parseCargoArgv = (input: readonly string[]): ParsedCargoArgv => {
  const argv = [...input];
  if (argv[0] !== undefined && cargoExecutablePattern.test(argv[0])) {
    argv.shift();
  } else if (argv[0] !== undefined && /[/\\]/u.test(argv[0])) {
    // A path-shaped first argument is a program, and the only program the
    // broker runs is cargo. A mis-resolved shim once submitted
    // `~/.cargo/bin/rustup test …`; running it would fail and the path would
    // be recorded as the "subcommand" in every metrics view.
    throw new Error(`program must be cargo, got ${argv[0]}`);
  }

  const toolchainArgument = argv[0]?.startsWith('+') === true ? argv.shift() : undefined;
  const toolchain = toolchainArgument?.slice(1) || null;
  let manifestPath: string | null = null;
  const opaqueArguments: string[] = [];
  let targetDir: string | null = null;
  let subcommand: string | undefined;

  while (argv.length > 0) {
    const argument = argv.shift();
    if (argument === undefined) {
      break;
    }
    if (!argument.startsWith('-')) {
      subcommand = argument;
      break;
    }
    const [option, inlineValue] = optionParts(argument);
    if (option === '--manifest-path' || option === '--target-dir') {
      const optionValue = inlineValue ?? argv.shift();
      if (optionValue === undefined || optionValue.length === 0) {
        throw new Error(`${option} requires a value`);
      }
      if (option === '--manifest-path') {
        manifestPath = optionValue;
      } else {
        targetDir = optionValue;
      }
    } else if (globalOptionsWithValues.has(option) && inlineValue === undefined) {
      const optionValue = argv.shift();
      if (optionValue === undefined || optionValue.length === 0) {
        throw new Error(`${option} requires a value`);
      }
      opaqueArguments.push(argument, optionValue);
    } else {
      opaqueArguments.push(argument);
    }
  }

  if (subcommand === undefined) {
    throw new Error('cargo invocation requires a subcommand');
  }

  const packages: string[] = [];
  const excludes: string[] = [];
  const features: string[] = [];
  const filterExpressions: string[] = [];
  const targets: string[] = [];
  const testFilters: string[] = [];
  let allFeatures = false;
  let nextestCommand: string | null = null;
  let noDefaultFeatures = false;
  let profile = defaultCargoProfile(subcommand);
  let passthrough: string[] = [];
  let targetTriple: string | null = null;
  let workspace = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--') {
      // Trailing arguments feed the intent key for every subcommand: rustc
      // compiler flags, libtest filters, and program arguments all change
      // what the invocation does.
      passthrough = argv.slice(index + 1);
      break;
    }

    const [option, inlineValue] = optionParts(argument);
    const takeValue = (): string => {
      if (inlineValue !== undefined && inlineValue.length > 0) {
        return inlineValue;
      }
      const following = argv[index + 1];
      if (following === undefined || following === '--') {
        throw new Error(`${option} requires a value`);
      }
      index += 1;
      return following;
    };

    switch (option) {
      case '-p':
      case '--package': {
        const packageName = takeValue();
        packages.push(packageName);
        break;
      }
      case '--exclude': {
        const excludedPackage = takeValue();
        excludes.push(excludedPackage);
        break;
      }
      case '-F':
      case '--features': {
        const featureList = takeValue();
        features.push(...splitFeatures(featureList));
        break;
      }
      case '--manifest-path':
        manifestPath = takeValue();
        break;
      case '--profile':
        profile = takeValue();
        break;
      case '--target':
        targetTriple = takeValue();
        break;
      case '--target-dir':
        targetDir = takeValue();
        break;
      case '--bin':
      case '--example':
      case '--test':
      case '--bench': {
        const targetName = takeValue();
        targets.push(`${option.slice(2)}:${targetName}`);
        break;
      }
      case '--lib':
      case '--doc':
      case '--bins':
      case '--examples':
      case '--tests':
      case '--benches':
      case '--all-targets':
        targets.push(option.slice(2));
        break;
      case '-E':
      case '--filterset':
      case '--filter-expr': {
        // A filterset only means selection under nextest; elsewhere the
        // token is unmodeled and stays opaque (without consuming a value).
        if (subcommand === 'nextest') {
          filterExpressions.push(takeValue());
        } else {
          opaqueArguments.push(argument);
        }
        break;
      }
      case '--all':
      case '--workspace':
        workspace = true;
        break;
      case '--all-features':
        allFeatures = true;
        break;
      case '--no-default-features':
        noDefaultFeatures = true;
        break;
      case '-r':
      case '--release':
        profile = 'release';
        break;
      case '--debug':
        profile = 'dev';
        break;
      default:
        if (argument.startsWith('-')) {
          opaqueArguments.push(argument);
          if (inlineValue === undefined && opaqueOptionTakesValue(subcommand, option)) {
            opaqueArguments.push(takeValue());
          }
        } else if (!testFilterSubcommands.has(subcommand)) {
          opaqueArguments.push(argument);
        } else if (subcommand === 'nextest' && nextestCommand === null) {
          nextestCommand = argument;
        } else {
          testFilters.push(argument);
        }
        break;
    }
  }

  return {
    allFeatures,
    excludes: sortedUnique(excludes),
    features: sortedUnique(features),
    filterExpressions: sortedUnique(filterExpressions),
    manifestPath,
    nextestCommand,
    noDefaultFeatures,
    opaqueArguments,
    packages: sortedUnique(packages),
    passthrough,
    profile,
    subcommand,
    targetDir,
    targetTriple,
    targets: sortedUnique(targets),
    testFilters: sortedUnique(testFilters),
    toolchain,
    workspace,
  };
};

export const normalizeCargoIntent = (
  options: NormalizeCargoIntentOptions,
): NormalizedCargoIntent => {
  const parsed = parseCargoArgv(options.argv);
  const env = options.env ?? {};
  const cwd = canonicalPath(options.cwd);
  const workspaceRoot = canonicalPath(options.workspaceRoot);
  const selectedTargetDir =
    parsed.targetDir ??
    env.CARGO_TARGET_DIR ??
    env.CARGO_BUILD_TARGET_DIR ??
    options.configuredTargetDir ??
    resolve(workspaceRoot, 'target');
  const targetDirBase =
    parsed.targetDir !== null ||
    env.CARGO_TARGET_DIR !== undefined ||
    env.CARGO_BUILD_TARGET_DIR !== undefined
      ? cwd
      : workspaceRoot;
  const targetDir = resolveFrom(targetDirBase, selectedTargetDir);
  const manifestPath =
    parsed.manifestPath === null ? null : resolveFrom(cwd, parsed.manifestPath);
  const toolchain = parsed.toolchain ?? env.RUSTUP_TOOLCHAIN ?? 'default';
  const targetTriple = parsed.targetTriple ?? env.CARGO_BUILD_TARGET ?? null;
  const envDigest = digestCargoEnvironment(env);
  const surface = {
    allFeatures: parsed.allFeatures,
    cwd,
    envDigest,
    excludes: parsed.excludes,
    features: parsed.features,
    filterExpressions: parsed.filterExpressions,
    manifestPath,
    nextestCommand: parsed.nextestCommand,
    noDefaultFeatures: parsed.noDefaultFeatures,
    opaqueArguments: parsed.opaqueArguments,
    packages: parsed.packages,
    passthrough: parsed.passthrough,
    profile: parsed.profile,
    subcommand: parsed.subcommand,
    targetDir,
    targetTriple,
    targets: parsed.targets,
    testFilters: parsed.testFilters,
    toolchain,
    workspace: parsed.workspace,
    workspaceRoot,
  };

  return {
    ...parsed,
    cwd,
    envDigest,
    key: sha256(`cargo-hauler-intent-v2\0${JSON.stringify(surface)}`),
    manifestPath,
    targetDir,
    targetTriple,
    toolchain,
    workspaceRoot,
  };
};
