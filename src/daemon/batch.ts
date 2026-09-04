import { namedPackagesInArgv } from '../lib/argv.js';

import { sameCompileSurface, stringArraysEqual } from './coverage.js';
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
 * The test selection a `cargo test` composite would run for every package:
 * `--test` targets, positional name filters, and the harness arguments after
 * `--`. Positional filters and post-`--` filters reach libtest the same way,
 * but the composite is the leader's argv, so each must match byte for byte.
 */
const sameTestSelection = (
  leader: NormalizedCargoIntent,
  candidate: NormalizedCargoIntent,
): boolean =>
  stringArraysEqual(leader.targets, candidate.targets) &&
  stringArraysEqual(leader.testFilters, candidate.testFilters) &&
  stringArraysEqual(leader.passthrough, candidate.passthrough);

/**
 * Whether `candidate` can fold into a composite of `kind` led by `leader`.
 * Every kind needs an identical compile surface and an identical selection
 * (each eligibility gate pins the candidate's subcommand); only the package
 * sets may differ. For `cargo test` the selection is the `--test` target
 * set, the name filters, and the arguments after `--`; for nextest it is
 * the filterset. The composite is therefore the leader's argv plus the
 * followers' `-p` flags and runs exactly what each participant asked for
 * over the union of their packages — never a foreign target or filter
 * (#53).
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
      return (
        testBatchEligible(candidate) &&
        sameCompileSurface(leader, candidate) &&
        sameTestSelection(leader, candidate)
      );
    case 'nextest':
      return (
        nextestBatchEligible(candidate) &&
        sameCompileSurface(leader, candidate) &&
        stringArraysEqual(leader.filterExpressions, candidate.filterExpressions)
      );
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
};

/** Every package a composite ran: the leader's plus each folded participant's. */
export const compositePackages = (
  leader: NormalizedCargoIntent,
  participants: readonly NormalizedCargoIntent[],
): readonly string[] => {
  const union: string[] = [];
  for (const participant of [leader, ...participants]) {
    for (const name of participant.packages) {
      if (!union.includes(name)) {
        union.push(name);
      }
    }
  }
  return union;
};

/**
 * Whether a folded participant owns the composite's failure. A test or
 * nextest composite runs the participants' shared selection over the union
 * of their packages with `--no-fail-fast`, so cargo's non-zero exit is a
 * participant's own only when it named every package the composite ran.
 * Otherwise the failure may live in a package it never asked for, and —
 * because cargo's test output does not attribute failures to packages
 * reliably — the participant requeues to run alone instead of inheriting a
 * false failure (#53). Compile batches always requeue (the demux proves
 * cleanly compiled demands separately). The leader keeps the composite's
 * exit, as compile-batch leaders do.
 */
export const batchFailureOwned = (
  leader: NormalizedCargoIntent,
  composite: readonly string[],
  participant: NormalizedCargoIntent,
): boolean =>
  testFoldSubcommands.has(leader.subcommand) &&
  composite.every((name) => participant.packages.includes(name));

/**
 * Extends the leader's `cargo test` / `cargo nextest run` argv to serve
 * every participant: the followers' `-p` flags join the leader's, and
 * `--no-fail-fast` keeps one package's failing tests from skipping
 * another's. Nothing else changes — `batchCompatibleFor` admits only
 * followers whose selection and compile surface already match the leader's.
 */
export const composeTestFoldArgv = (
  leaderArgv: readonly string[],
  followers: readonly NormalizedCargoIntent[],
): string[] => {
  const argv = withExtraPackages(
    leaderArgv,
    followers.flatMap((follower) => follower.packages),
  );
  const insertAt = trailerIndex(argv);
  if (argv.slice(0, insertAt).includes('--no-fail-fast')) {
    return argv;
  }
  return [...argv.slice(0, insertAt), '--no-fail-fast', ...argv.slice(insertAt)];
};
