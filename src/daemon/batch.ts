import { namedPackagesInArgv } from '../lib/argv.js';

import { sameCompileSurface, stringArraysEqual } from './coverage.js';
import { cargoExecutablePattern } from './intent-normalizer.js';
import type { NormalizedCargoIntent } from './intent-normalizer.js';

/** Subcommands whose invocations may be merged into one multi-package run. */
const batchableSubcommands = new Set(['build', 'check', 'clippy']);

/** Test-run subcommands whose invocations may fold into one composite run. */
const testFoldSubcommands = new Set(['nextest', 'test']);

/** Upper bound on packages merged into one composite invocation. */
export const maxBatchPackages = 16;

/** Whether an intent has the explicit-package shape composable into a batch. */
const batchLeaderEligible = (intent: NormalizedCargoIntent): boolean =>
  batchableSubcommands.has(intent.subcommand) &&
  !intent.workspace &&
  intent.packages.length > 0 &&
  intent.excludes.length === 0 &&
  intent.opaqueArguments.length === 0 &&
  intent.passthrough.length === 0;

/**
 * Whether `candidate` can be folded into a composite invocation led by
 * `leader`: same batchable subcommand, identical compile surface and target
 * selection, both with explicit package lists. The composite is the leader's
 * argv plus the candidate's `-p` flags, so everything outside the package
 * set must be byte-equivalent.
 */
export const batchCompatible = (
  leader: NormalizedCargoIntent,
  candidate: NormalizedCargoIntent,
): boolean =>
  leader.subcommand === candidate.subcommand &&
  batchLeaderEligible(leader) &&
  batchLeaderEligible(candidate) &&
  sameCompileSurface(leader, candidate) &&
  stringArraysEqual(leader.targets, candidate.targets);

/** Packages on `candidate` that the leader invocation does not already name. */
export const extraPackagesFor = (
  leader: NormalizedCargoIntent,
  candidate: NormalizedCargoIntent,
): readonly string[] => candidate.packages.filter((name) => !leader.packages.includes(name));

const trailerIndex = (argv: readonly string[]): number => {
  const passthrough = argv.indexOf('--');
  if (passthrough !== -1) {
    return passthrough;
  }
  const messageFormat = argv.findIndex(
    (part) => part === '--message-format' || part.startsWith('--message-format='),
  );
  return messageFormat === -1 ? argv.length : messageFormat;
};

/**
 * Append missing `-p` flags before a `--message-format` rewrite or `--`
 * passthrough so the composite cargo still sees the original trailer.
 */
export const withExtraPackages = (
  argv: readonly string[],
  extras: readonly string[],
): string[] => {
  const already = namedPackagesInArgv(argv);
  const flags: string[] = [];
  for (const name of extras) {
    if (already.has(name)) {
      continue;
    }
    already.add(name);
    flags.push('-p', name);
  }
  if (flags.length === 0) {
    return [...argv];
  }
  const insertAt = trailerIndex(argv);
  return [...argv.slice(0, insertAt), ...flags, ...argv.slice(insertAt)];
};

/** The composite always re-adds `--no-fail-fast`, so it is a benign opaque. */
const onlyNoFailFast = (opaque: readonly string[]): boolean =>
  opaque.every((argument) => argument === '--no-fail-fast');

/** Trailing harness arguments we can union: bare name filters, no flags. */
const onlyHarnessFilters = (passthrough: readonly string[]): boolean =>
  passthrough.every((argument) => !argument.startsWith('-'));

const integrationTestTargetPrefix = 'test:';

const onlyIntegrationTestTargets = (targets: readonly string[]): boolean =>
  targets.every((target) => target.startsWith(integrationTestTargetPrefix));

/**
 * Whether a `cargo test` intent has the shape composable into one composite
 * run: explicit packages (workspace-wide runs stay on the coverage path),
 * target narrowing expressible as `--test` flags, trailing arguments that
 * are pure libtest name filters (harness flags like `--exact` change filter
 * semantics for the whole run), and no unmodeled cargo flags.
 */
const testBatchEligible = (intent: NormalizedCargoIntent): boolean =>
  intent.subcommand === 'test' &&
  !intent.workspace &&
  intent.packages.length > 0 &&
  intent.excludes.length === 0 &&
  onlyNoFailFast(intent.opaqueArguments) &&
  onlyIntegrationTestTargets(intent.targets) &&
  onlyHarnessFilters(intent.passthrough);

/**
 * Whether a `cargo nextest run` intent can fold: explicit packages keep the
 * composite's build scope tight (an -E-only participant would need a
 * workspace-wide build to be a superset), and the whole selection must be
 * expressible as one filterset — positional filters and trailing arguments
 * intersect with `-E` in nextest, so their presence disqualifies folding.
 */
const nextestBatchEligible = (intent: NormalizedCargoIntent): boolean =>
  intent.subcommand === 'nextest' &&
  intent.nextestCommand === 'run' &&
  !intent.workspace &&
  intent.packages.length > 0 &&
  intent.excludes.length === 0 &&
  onlyNoFailFast(intent.opaqueArguments) &&
  intent.targets.length === 0 &&
  intent.testFilters.length === 0 &&
  intent.passthrough.length === 0;

export type BatchKind = 'compile' | 'nextest' | 'test';

/** How (if at all) this intent can lead or join a composite invocation. */
export const batchKindFor = (intent: NormalizedCargoIntent): BatchKind | null => {
  if (batchLeaderEligible(intent)) {
    return 'compile';
  }
  if (testBatchEligible(intent)) {
    return 'test';
  }
  if (nextestBatchEligible(intent)) {
    return 'nextest';
  }
  return null;
};

/**
 * Whether `candidate` can fold into a composite of `kind` led by `leader`.
 * Compile composites need identical target selection; test composites share
 * only the compile surface and take the union of target and filter
 * selections (each eligibility gate pins the candidate's subcommand).
 */
export const batchCompatibleFor = (
  kind: BatchKind,
  leader: NormalizedCargoIntent,
  candidate: NormalizedCargoIntent,
): boolean => {
  switch (kind) {
    case 'compile':
      return batchCompatible(leader, candidate);
    case 'test':
      return testBatchEligible(candidate) && sameCompileSurface(leader, candidate);
    case 'nextest':
      return nextestBatchEligible(candidate) && sameCompileSurface(leader, candidate);
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
};

/**
 * Folded test runs share the composite's full exit: `--no-fail-fast` ran
 * every participant's selection, so a failure belongs to all of them.
 * Compile batches keep requeue-on-failure semantics instead (the failure
 * may live in a foreign package).
 */
export const batchExitShared = (intent: NormalizedCargoIntent): boolean =>
  testFoldSubcommands.has(intent.subcommand);

const pushUnique = (values: string[], value: string): void => {
  if (!values.includes(value)) {
    values.push(value);
  }
};

const unionPackages = (participants: readonly NormalizedCargoIntent[]): readonly string[] => {
  const union: string[] = [];
  for (const participant of participants) {
    for (const name of participant.packages) {
      pushUnique(union, name);
    }
  }
  return union;
};

/** Union of `--test` targets; null when a participant runs the default set. */
const unionIntegrationTestTargets = (
  participants: readonly NormalizedCargoIntent[],
): readonly string[] | null => {
  const union: string[] = [];
  for (const participant of participants) {
    if (participant.targets.length === 0) {
      return null;
    }
    for (const target of participant.targets) {
      pushUnique(union, target.slice(integrationTestTargetPrefix.length));
    }
  }
  return union;
};

/** Union of libtest name filters (libtest ORs them); null when a participant filters nothing. */
const unionTestNameFilters = (
  participants: readonly NormalizedCargoIntent[],
): readonly string[] | null => {
  const union: string[] = [];
  for (const participant of participants) {
    const filters = [...participant.testFilters, ...participant.passthrough];
    if (filters.length === 0) {
      return null;
    }
    for (const filter of filters) {
      pushUnique(union, filter);
    }
  }
  return union;
};

/**
 * Index of the subcommand token. Sound only for fold-eligible intents:
 * eligibility leaves no unmodeled pre-subcommand option, so a leading dash
 * token is `--manifest-path`/`--target-dir` (value-taking) or an inline
 * `=` form.
 */
const subcommandIndex = (argv: readonly string[]): number => {
  let index = 0;
  const executable = argv[index];
  if (executable !== undefined && cargoExecutablePattern.test(executable)) {
    index += 1;
  }
  if (argv[index]?.startsWith('+') === true) {
    index += 1;
  }
  while (index < argv.length) {
    const token = argv[index];
    if (token === undefined || !token.startsWith('-')) {
      return index;
    }
    index += token === '--manifest-path' || token === '--target-dir' ? 2 : 1;
  }
  return -1;
};

const flagPresent = (argv: readonly string[], flag: string): boolean =>
  argv.some((token) => token === flag || token.startsWith(`${flag}=`));

/**
 * Rebuilds one `cargo test` invocation that serves every participant.
 * Superset semantics throughout: packages and `--test` targets union,
 * name filters union after `--` (libtest ORs them), and any participant
 * without a narrowing drops that narrowing from the composite entirely.
 * `--no-fail-fast` keeps one participant's failing target from skipping
 * another's tests. Faithful because eligibility admits only fully modeled
 * flags and `sameCompileSurface` pins the followers to the leader's
 * features, profile, toolchain, and target triple.
 */
export const composeTestBatchArgv = (
  leaderArgv: readonly string[],
  leader: NormalizedCargoIntent,
  followers: readonly NormalizedCargoIntent[],
): string[] => {
  const participants = [leader, ...followers];
  const argv = [...leaderArgv.slice(0, subcommandIndex(leaderArgv) + 1)];
  for (const name of unionPackages(participants)) {
    argv.push('-p', name);
  }
  if (leader.allFeatures) {
    argv.push('--all-features');
  }
  if (leader.noDefaultFeatures) {
    argv.push('--no-default-features');
  }
  if (leader.features.length > 0) {
    argv.push('--features', leader.features.join(','));
  }
  if (leader.profile !== 'test') {
    argv.push('--profile', leader.profile);
  }
  if (leader.targetTriple !== null && flagPresent(leaderArgv, '--target')) {
    argv.push('--target', leader.targetTriple);
  }
  if (leader.manifestPath !== null && !flagPresent(argv, '--manifest-path')) {
    argv.push('--manifest-path', leader.manifestPath);
  }
  if (flagPresent(leaderArgv, '--target-dir') && !flagPresent(argv, '--target-dir')) {
    argv.push('--target-dir', leader.targetDir);
  }
  const testTargets = unionIntegrationTestTargets(participants);
  if (testTargets !== null) {
    for (const name of testTargets) {
      argv.push('--test', name);
    }
  }
  argv.push('--no-fail-fast');
  const filters = unionTestNameFilters(participants);
  if (filters !== null) {
    argv.push('--', ...filters);
  }
  return argv;
};

const filterExpressionFlags = new Set(['-E', '--filterset', '--filter-expr']);

const isInlineFilterExpression = (token: string): boolean =>
  token.startsWith('-E=') || token.startsWith('--filterset=') || token.startsWith('--filter-expr=');

/** Leader argv minus its own filterset flags (the composite re-expresses them). */
const withoutFilterExpressions = (argv: readonly string[]): string[] => {
  const result: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) {
      continue;
    }
    if (token === '--') {
      result.push(...argv.slice(index));
      break;
    }
    if (filterExpressionFlags.has(token)) {
      index += 1;
      continue;
    }
    if (isInlineFilterExpression(token)) {
      continue;
    }
    result.push(token);
  }
  return result;
};

/** One participant's selection as a nextest filterset expression. */
const nextestSelectionExpression = (intent: NormalizedCargoIntent): string => {
  const expressions =
    intent.filterExpressions.length > 0
      ? intent.filterExpressions
      : intent.packages.map((name) => `package(${name})`);
  return expressions.length === 1
    ? expressions.join('')
    : expressions.map((expression) => `(${expression})`).join(' or ');
};

/**
 * Extends the leader's `cargo nextest run` argv to serve every participant:
 * one composite `-E` ORs each participant's selection (its own filtersets,
 * or `package(...)` terms from its `-p` flags), `-p` flags union to keep the
 * build scope tight, and `--no-fail-fast` protects participants from each
 * other's failures.
 */
export const composeNextestBatchArgv = (
  leaderArgv: readonly string[],
  leader: NormalizedCargoIntent,
  followers: readonly NormalizedCargoIntent[],
): string[] => {
  const participants = [leader, ...followers];
  const expression = participants
    .map((participant) => `(${nextestSelectionExpression(participant)})`)
    .join(' or ');
  const base = withExtraPackages(
    withoutFilterExpressions(leaderArgv),
    followers.flatMap((follower) => follower.packages),
  );
  const insertAt = trailerIndex(base);
  const insertion = ['-E', expression];
  if (!base.slice(0, insertAt).includes('--no-fail-fast')) {
    insertion.push('--no-fail-fast');
  }
  return [...base.slice(0, insertAt), ...insertion, ...base.slice(insertAt)];
};
