import { namedPackagesInArgv, optionParts } from '../lib/argv.js';

import { sameCompileSurface, stringArraysEqual } from './coverage.js';
import type { NormalizedCargoIntent } from './intent-normalizer.js';

/** Subcommands whose invocations may be merged into one multi-package run. */
const batchableSubcommands = new Set(['build', 'check', 'clippy']);

/** Test-run subcommands whose invocations may fold into one composite run. */
const testFoldSubcommands = new Set(['nextest', 'test']);

/** Upper bound on packages merged into one composite invocation. */
export const maxBatchPackages = 16;

/**
 * Whether an intent has the explicit-package shape composable into a batch.
 * A `--` trailer (`cargo clippy … -- -D warnings`) is allowed: the composite
 * keeps the leader's trailer once, so `batchCompatible` admits only
 * followers whose trailer is byte-equal (#86).
 */
const batchLeaderEligible = (intent: NormalizedCargoIntent): boolean =>
  batchableSubcommands.has(intent.subcommand) &&
  !intent.workspace &&
  intent.packages.length > 0 &&
  intent.excludes.length === 0 &&
  intent.opaqueArguments.length === 0;

/**
 * Whether `candidate` can be folded into a composite invocation led by
 * `leader`: same batchable subcommand, identical compile surface, target
 * selection, and `--` trailer, both with explicit package lists. The
 * composite is the leader's argv plus the candidate's `-p` flags, so
 * everything outside the package set must be byte-equivalent. Under
 * `-- -D warnings` another participant's warnings fail the composite; the
 * demux still proves a follower whose own units compiled cleanly, and the
 * rest requeue to run alone.
 */
export const batchCompatible = (
  leader: NormalizedCargoIntent,
  candidate: NormalizedCargoIntent,
): boolean =>
  leader.subcommand === candidate.subcommand &&
  batchLeaderEligible(leader) &&
  batchLeaderEligible(candidate) &&
  sameCompileSurface(leader, candidate) &&
  stringArraysEqual(leader.targets, candidate.targets) &&
  stringArraysEqual(leader.passthrough, candidate.passthrough);

/** Packages on `candidate` that the leader invocation does not already name. */
export const extraPackagesFor = (
  leader: NormalizedCargoIntent,
  candidate: NormalizedCargoIntent,
): readonly string[] => candidate.packages.filter((name) => !leader.packages.includes(name));

/**
 * Where the leader's argv stops taking cargo flags: the earlier of the demux
 * `--message-format` rewrite and the `--` passthrough (a demuxed clippy has
 * both, in that order), or the end when it has neither.
 */
const trailerIndex = (argv: readonly string[]): number => {
  const trailer = argv.findIndex(
    (part) =>
      part === '--' || part === '--message-format' || part.startsWith('--message-format='),
  );
  return trailer === -1 ? argv.length : trailer;
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

/**
 * The libtest arguments after `--` of a `cargo test`, split into what they
 * select and how they run it.
 */
export interface TestTrailer {
  /** Bare name filters (substring matches, OR-ed by libtest), in argv order. */
  readonly filters: readonly string[];
  /**
   * Foldable harness flags in canonical spelling, sorted: `--test-threads=N`,
   * `--nocapture`, `--quiet`. They change how tests run, never which tests
   * run, so participants carrying the same set can share one run.
   */
  readonly harness: readonly string[];
}

/**
 * Classifies a `cargo test` trailer for folding (#87). The foldable harness
 * flags are deliberately few: `--test-threads=N` (also the two-token
 * `--test-threads N`), `--nocapture`, and `--quiet` / `-q`. Every other
 * flag returns null and keeps the run out of composites — `--exact`,
 * `--skip`, `--ignored`, `--include-ignored`, `--list`, `--format`,
 * `--logfile`, or anything unmodeled changes which tests run, how their
 * names match, or what the run produces, and a composite would apply it to
 * every participant.
 */
export const classifyTestTrailer = (passthrough: readonly string[]): TestTrailer | null => {
  const filters: string[] = [];
  const harness = new Set<string>();
  for (let index = 0; index < passthrough.length; index += 1) {
    const argument = passthrough[index];
    if (argument === undefined) {
      continue;
    }
    if (!argument.startsWith('-')) {
      filters.push(argument);
      continue;
    }
    const [option, inlineValue] = optionParts(argument);
    switch (option) {
      case '--test-threads': {
        const value = inlineValue ?? passthrough[index + 1];
        if (value === undefined || value.length === 0 || value.startsWith('-')) {
          return null;
        }
        if (inlineValue === undefined) {
          index += 1;
        }
        harness.add(`--test-threads=${value}`);
        break;
      }
      case '--nocapture':
        if (inlineValue !== undefined) {
          return null;
        }
        harness.add('--nocapture');
        break;
      case '-q':
      case '--quiet':
        if (inlineValue !== undefined) {
          return null;
        }
        harness.add('--quiet');
        break;
      default:
        return null;
    }
  }
  return { filters, harness: [...harness].sort((left, right) => left.localeCompare(right)) };
};

/**
 * Every name filter a `cargo test` intent hands libtest: the positional
 * `cargo test <NAME>` and the bare filters after `--` reach the test
 * binaries the same way (cargo forwards both, in that order).
 */
const testNameFilters = (intent: NormalizedCargoIntent): readonly string[] => [
  ...intent.testFilters,
  ...(classifyTestTrailer(intent.passthrough)?.filters ?? []),
];

const integrationTestTargetPrefix = 'test:';

/**
 * Target narrowing a `cargo test` composite can carry for every package:
 * `--test NAME` and `--lib`. Both select per package — each participant's
 * own integration test or unit tests — so, identical across participants,
 * the composite runs exactly each one's selection over its packages. Other
 * shapes (`--doc`, `--bins`, `--bin NAME`, …) stay unfolded for now.
 */
const foldableTestTargets = (targets: readonly string[]): boolean =>
  targets.every((target) => target === 'lib' || target.startsWith(integrationTestTargetPrefix));

/**
 * Whether a `cargo test` intent has the shape composable into one composite
 * run: explicit packages (workspace-wide runs stay on the coverage path),
 * target narrowing expressible as `--test` / `--lib` flags, a trailer of
 * bare name filters and foldable harness flags only (`classifyTestTrailer`),
 * and no unmodeled cargo flags.
 */
const testBatchEligible = (intent: NormalizedCargoIntent): boolean =>
  intent.subcommand === 'test' &&
  !intent.workspace &&
  intent.packages.length > 0 &&
  intent.excludes.length === 0 &&
  onlyNoFailFast(intent.opaqueArguments) &&
  foldableTestTargets(intent.targets) &&
  classifyTestTrailer(intent.passthrough) !== null;

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

const sameStringSet = (left: readonly string[], right: readonly string[]): boolean =>
  left.every((value) => right.includes(value)) && right.every((value) => left.includes(value));

/**
 * Whether two `cargo test` selections can share one composite (#87). The
 * `--test` / `--lib` target set and the harness flags must match exactly:
 * the composite runs the leader's targets and trailer for every package.
 * Between participants naming different packages — the fold that shares a
 * compile — name filters may differ: the composite runs the union of
 * packages with the union of filters, so every participant's tests are
 * selected (plus, at most, other participants' filters matching names in
 * its packages). An unfiltered run never joins a filtered one, though: it
 * asked for every test in its packages, and any filter would narrow it.
 * Participants naming the same packages share no compile, so they keep the
 * identical-selection rule (#53): same filters, in any spelling or order.
 */
const testSelectionsFold = (
  leader: NormalizedCargoIntent,
  candidate: NormalizedCargoIntent,
): boolean => {
  if (!stringArraysEqual(leader.targets, candidate.targets)) {
    return false;
  }
  const leaderTrailer = classifyTestTrailer(leader.passthrough);
  const candidateTrailer = classifyTestTrailer(candidate.passthrough);
  if (
    leaderTrailer === null ||
    candidateTrailer === null ||
    !stringArraysEqual(leaderTrailer.harness, candidateTrailer.harness)
  ) {
    return false;
  }
  const leaderFilters = testNameFilters(leader);
  const candidateFilters = testNameFilters(candidate);
  if (stringArraysEqual(leader.packages, candidate.packages)) {
    return sameStringSet(leaderFilters, candidateFilters);
  }
  return (leaderFilters.length === 0) === (candidateFilters.length === 0);
};

/**
 * Whether `candidate` can fold into a composite of `kind` led by `leader`.
 * Every kind needs an identical compile surface (each eligibility gate pins
 * the candidate's subcommand); the package sets may differ. A compile batch
 * also needs identical targets and `--` trailer; a nextest composite an
 * identical filterset; a `cargo test` composite identical `--test` / `--lib`
 * targets and harness flags, while the name filters of participants naming
 * different packages union (#87). The composite is
 * therefore the leader's argv plus the followers' `-p` flags (and, for
 * `cargo test`, their extra filters) and runs every participant's
 * selection over the union of their packages — never a foreign target,
 * filterset, or harness flag (#53).
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
        testSelectionsFold(leader, candidate)
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

/** Union in first-seen order: the leader's values first, then each participant's new ones. */
const unionInOrder = (
  leader: NormalizedCargoIntent,
  participants: readonly NormalizedCargoIntent[],
  select: (intent: NormalizedCargoIntent) => readonly string[],
): readonly string[] => {
  const union: string[] = [];
  for (const participant of [leader, ...participants]) {
    for (const value of select(participant)) {
      if (!union.includes(value)) {
        union.push(value);
      }
    }
  }
  return union;
};

/** Every package a composite ran: the leader's plus each folded participant's. */
export const compositePackages = (
  leader: NormalizedCargoIntent,
  participants: readonly NormalizedCargoIntent[],
): readonly string[] => unionInOrder(leader, participants, (intent) => intent.packages);

/**
 * Every name filter a `cargo test` composite ran: the leader's plus each
 * folded participant's, leader first, deduplicated. Empty for unfiltered
 * runs and for nextest composites (whose selection is the shared filterset).
 */
export const compositeTestFilters = (
  leader: NormalizedCargoIntent,
  participants: readonly NormalizedCargoIntent[],
): readonly string[] => unionInOrder(leader, participants, testNameFilters);

/** What a test or nextest composite actually ran, for attributing its failure. */
export interface CompositeSelection {
  readonly packages: readonly string[];
  readonly filters: readonly string[];
}

export const compositeSelection = (
  leader: NormalizedCargoIntent,
  participants: readonly NormalizedCargoIntent[],
): CompositeSelection => ({
  packages: compositePackages(leader, participants),
  filters: compositeTestFilters(leader, participants),
});

/**
 * Whether a folded participant owns the composite's failure. A test or
 * nextest composite runs the union of the participants' packages — and, for
 * `cargo test`, the union of their name filters — with `--no-fail-fast`, so
 * cargo's non-zero exit is a participant's own only when the composite ran
 * nothing it did not ask for: it named every package the composite ran and
 * every filter the composite selected. Otherwise the failure may live in a
 * package or a test it never asked for, and — because cargo's test output
 * does not attribute failures to packages reliably — the participant
 * requeues to run alone instead of inheriting a false failure (#53, #87).
 * Compile batches always requeue (the demux proves cleanly compiled demands
 * separately). The leader keeps the composite's exit, as compile-batch
 * leaders do.
 */
export const batchFailureOwned = (
  leader: NormalizedCargoIntent,
  composite: CompositeSelection,
  participant: NormalizedCargoIntent,
): boolean => {
  if (!testFoldSubcommands.has(leader.subcommand)) {
    return false;
  }
  const filters = testNameFilters(participant);
  return (
    composite.packages.every((name) => participant.packages.includes(name)) &&
    composite.filters.every((filter) => filters.includes(filter))
  );
};

/**
 * Extends the leader's `cargo test` / `cargo nextest run` argv to serve
 * every participant: the followers' `-p` flags join the leader's,
 * `--no-fail-fast` keeps one package's failing tests from skipping
 * another's, and name filters the followers add (none for nextest, whose
 * filterset already matches) go after `--`, following the leader's own
 * trailer so it runs once and unchanged — libtest OR-s every free argument
 * as a filter wherever it sits among the flags. `batchCompatibleFor` admits
 * only followers whose targets, harness flags, and compile surface already
 * match the leader's.
 */
export const composeTestFoldArgv = (
  leaderArgv: readonly string[],
  leader: NormalizedCargoIntent,
  followers: readonly NormalizedCargoIntent[],
): string[] => {
  const argv = withExtraPackages(
    leaderArgv,
    followers.flatMap((follower) => follower.packages),
  );
  const insertAt = trailerIndex(argv);
  const withNoFailFast = argv.slice(0, insertAt).includes('--no-fail-fast')
    ? argv
    : [...argv.slice(0, insertAt), '--no-fail-fast', ...argv.slice(insertAt)];
  const leaderFilters = testNameFilters(leader);
  const extraFilters = compositeTestFilters(leader, followers).filter(
    (filter) => !leaderFilters.includes(filter),
  );
  if (extraFilters.length === 0) {
    return withNoFailFast;
  }
  return withNoFailFast.includes('--')
    ? [...withNoFailFast, ...extraFilters]
    : [...withNoFailFast, '--', ...extraFilters];
};
