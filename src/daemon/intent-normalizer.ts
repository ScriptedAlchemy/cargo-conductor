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
  /**
   * `NAME=value` assignments from a leading `env` (or a shell statement's
   * own `NAME=value cargo …` prefix), applied over the request environment
   * and part of the intent key.
   */
  readonly envAssignments: Readonly<Record<string, string>>;
  /** Names a leading `env -u` removes from the request environment. */
  readonly envUnset: readonly string[];
  /**
   * The script of a `bash -c` / `sh -c` wrapper whose single cargo statement
   * this intent was read from; null for a direct cargo argv. A wrapped
   * request is scheduled, estimated, and phase-tracked as its cargo tail but
   * never shared: the rest of the script may do anything.
   */
  readonly shellScript: string | null;
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
const envProgramPattern = /(?:^|[/\\])env$/u;
const shellProgramPattern = /(?:^|[/\\])(?:bash|sh|zsh|dash)$/u;
const shellAssignmentPattern = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/u;
/** A POSIX shell flag cluster that carries `-c` (`-c`, `-lc`, `-ec`). */
const shellCommandFlagPattern = /^-[a-zA-Z]*c[a-zA-Z]*$/u;

interface ProgramPrefix {
  readonly argv: string[];
  readonly envAssignments: Record<string, string>;
  readonly envUnset: string[];
  readonly opaque: string[];
  readonly peeled: boolean;
}

/**
 * Folds a leading `env NAME=value … -u NAME …` into environment edits so the
 * cargo behind it is modeled (subcommand, packages, surface) instead of being
 * recorded as the subcommand `env` (#126). `env -i` is kept as an opaque
 * argument: it clears the environment, so the compile surface is unknowable
 * and the request must not be shared. Any other `env` option (`-C`, `-S`,
 * `-0`) is refused; cargo is the only program the broker models.
 */
const peelEnvPrefix = (input: readonly string[]): ProgramPrefix => {
  const argv = [...input];
  const envAssignments: Record<string, string> = {};
  const envUnset: string[] = [];
  const opaque: string[] = [];
  const program = argv[0];
  if (program === undefined || !envProgramPattern.test(program)) {
    return { argv, envAssignments, envUnset, opaque, peeled: false };
  }
  argv.shift();
  while (argv.length > 0) {
    const argument = argv[0];
    if (argument === undefined) {
      break;
    }
    const assignment = shellAssignmentPattern.exec(argument);
    if (assignment !== null) {
      envAssignments[assignment[1] ?? ''] = assignment[2] ?? '';
      argv.shift();
      continue;
    }
    if (argument === '-u' || argument === '--unset') {
      argv.shift();
      const name = argv.shift();
      if (name === undefined || name.length === 0) {
        throw new Error(`${argument} requires a name`);
      }
      envUnset.push(name);
      continue;
    }
    if (argument.startsWith('--unset=')) {
      envUnset.push(argument.slice('--unset='.length));
      argv.shift();
      continue;
    }
    if (argument === '-i' || argument === '--ignore-environment' || argument === '-') {
      opaque.push(argument);
      argv.shift();
      continue;
    }
    if (argument === '--') {
      argv.shift();
      break;
    }
    if (argument.startsWith('-')) {
      throw new Error(
        `unsupported env option ${argument}: only NAME=value, -u NAME, and -i are brokered`,
      );
    }
    break;
  }
  return { argv, envAssignments, envUnset, opaque, peeled: true };
};

/**
 * Splits a `-c` script into statements at `;`, newlines, `&&`, `||`, `|`,
 * and `&`, respecting single and double quotes. Good enough to find the one
 * cargo statement an agent wrapped in `bash -lc 'source …; cargo bench …'`;
 * anything more elaborate simply yields no tail.
 */
export const splitShellStatements = (script: string): string[] => {
  const statements: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < script.length; index += 1) {
    const char = script[index] ?? '';
    if (quote !== null) {
      current += char;
      if (char === '\\' && quote === '"') {
        current += script[index + 1] ?? '';
        index += 1;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === '\\') {
      current += char + (script[index + 1] ?? '');
      index += 1;
      continue;
    }
    const pair = script.slice(index, index + 2);
    if (pair === '&&' || pair === '||') {
      statements.push(current);
      current = '';
      index += 1;
      continue;
    }
    if (char === ';' || char === '\n' || char === '|' || char === '&') {
      statements.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  statements.push(current);
  return statements.map((statement) => statement.trim()).filter((statement) => statement.length > 0);
};

/** Shell-word split of one statement: quotes group, backslashes escape, both are stripped. */
export const splitShellWords = (statement: string): string[] => {
  const words: string[] = [];
  let current = '';
  let inWord = false;
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < statement.length; index += 1) {
    const char = statement[index] ?? '';
    if (quote !== null) {
      if (char === quote) {
        quote = null;
      } else if (char === '\\' && quote === '"') {
        current += statement[index + 1] ?? '';
        index += 1;
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      inWord = true;
      continue;
    }
    if (char === '\\') {
      current += statement[index + 1] ?? '';
      index += 1;
      inWord = true;
      continue;
    }
    if (/\s/u.test(char)) {
      if (inWord) {
        words.push(current);
        current = '';
        inWord = false;
      }
      continue;
    }
    current += char;
    inWord = true;
  }
  if (inWord) {
    words.push(current);
  }
  return words;
};

interface ShellCargoTail {
  readonly argv: string[];
  readonly envAssignments: Record<string, string>;
  readonly envUnset: string[];
  readonly opaque: string[];
}

/**
 * The cargo invocation inside one shell statement: an optional `exec`, then
 * `NAME=value` prefixes and/or an `env` prefix, then cargo. Null when the
 * statement runs something else.
 */
const cargoTailOfStatement = (statement: string): ShellCargoTail | null => {
  const words = splitShellWords(statement);
  const envAssignments: Record<string, string> = {};
  const takeAssignments = (): void => {
    while (words.length > 0) {
      const assignment = shellAssignmentPattern.exec(words[0] ?? '');
      if (assignment === null) {
        return;
      }
      envAssignments[assignment[1] ?? ''] = assignment[2] ?? '';
      words.shift();
    }
  };
  // `FOO=1 exec BAR=2 cargo …`: assignments may sit on either side of exec.
  takeAssignments();
  if (words[0] === 'exec') {
    words.shift();
    takeAssignments();
  }
  let prefix: ProgramPrefix;
  try {
    prefix = peelEnvPrefix(words);
  } catch {
    return null;
  }
  const program = prefix.argv[0];
  if (program === undefined || !cargoExecutablePattern.test(program)) {
    return null;
  }
  return {
    argv: prefix.argv,
    envAssignments: { ...envAssignments, ...prefix.envAssignments },
    envUnset: prefix.envUnset,
    opaque: prefix.opaque,
  };
};

interface ShellWrapper {
  readonly script: string;
  /** The single cargo statement's tail, or null when the script has none or several. */
  readonly tail: ShellCargoTail | null;
}

/**
 * Recognizes `bash -c SCRIPT` (also `-lc`, `sh -c`, `zsh -c`, `dash -c`)
 * and reads the one cargo statement inside it. A script with no cargo, or
 * with several (`cargo build && cargo test`), yields no tail: the request
 * then keeps the shell as its subcommand, as before, since a single
 * build-finished line could not be attributed to one cargo.
 */
const peelShellWrapper = (argv: readonly string[]): ShellWrapper | null => {
  const program = argv[0];
  if (program === undefined || !shellProgramPattern.test(program)) {
    return null;
  }
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index] ?? '';
    if (!argument.startsWith('-')) {
      return null;
    }
    if (argument === '--') {
      return null;
    }
    if (shellCommandFlagPattern.test(argument)) {
      const script = argv[index + 1];
      if (script === undefined) {
        return null;
      }
      const tails = splitShellStatements(script)
        .map(cargoTailOfStatement)
        .filter((tail): tail is ShellCargoTail => tail !== null);
      return { script, tail: tails.length === 1 ? (tails[0] ?? null) : null };
    }
  }
  return null;
};

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
  const prefix = peelEnvPrefix(input);
  let argv = prefix.argv;
  const envAssignments = prefix.envAssignments;
  const envUnset = prefix.envUnset;
  const prefixOpaque = prefix.opaque;
  let shellScript: string | null = null;
  const wrapper = peelShellWrapper(argv);
  if (wrapper !== null) {
    shellScript = wrapper.script;
    if (wrapper.tail !== null) {
      // The whole wrapper argv stays opaque: it feeds the intent key (two
      // different scripts are two different requests) and it disqualifies
      // batching and coverage, which could not reason about the script.
      prefixOpaque.push(...argv);
      argv = wrapper.tail.argv;
      Object.assign(envAssignments, wrapper.tail.envAssignments);
      envUnset.push(...wrapper.tail.envUnset);
      prefixOpaque.push(...wrapper.tail.opaque);
    }
  }
  if (argv[0] !== undefined && cargoExecutablePattern.test(argv[0])) {
    argv.shift();
  } else if (prefix.peeled) {
    throw new Error(`program must be cargo, got ${argv[0] ?? 'nothing'}`);
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
  const opaqueArguments: string[] = [...prefixOpaque];
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
    envAssignments,
    envUnset: sortedUnique(envUnset),
    shellScript,
  };
};

export const normalizeCargoIntent = (
  options: NormalizeCargoIntentOptions,
): NormalizedCargoIntent => {
  const parsed = parseCargoArgv(options.argv);
  // A leading `env` edits the environment cargo actually sees; the edited
  // environment selects the target dir, toolchain, triple, and digest.
  const env: Record<string, string | undefined> = { ...(options.env ?? {}) };
  for (const name of parsed.envUnset) {
    delete env[name];
  }
  Object.assign(env, parsed.envAssignments);
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
    envAssignments: parsed.envAssignments,
    envDigest,
    envUnset: parsed.envUnset,
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
