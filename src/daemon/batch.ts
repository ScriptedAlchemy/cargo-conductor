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
  /**
   * Bare name filters in argv order. libtest OR-s them: a test runs when any
   * filter matches its name, as a substring or — under `--exact` — whole.
   */
  readonly filters: readonly string[];
  /**
   * Foldable harness flags in canonical spelling, sorted: `--exact`,
   * `--nocapture`, `--quiet`, `--test-threads=N`. Participants carrying the
   * same set can share one run: the last three change how tests run, never
   * which run, and `--exact` applies to each filter of the union alike, so
   * the composite still selects exactly what every participant asked for.
   */
  readonly harness: readonly string[];
}

/** One libtest argument of a `cargo test` trailer, ending just before `end`. */
interface TrailerArgument {
  readonly kind: 'filter' | 'harness';
  /** The filter itself, or the harness flag in canonical spelling. */
  readonly value: string;
  /** Index in the trailer just past this argument's tokens. */
  readonly end: number;
}

/**
 * Walks a `cargo test` trailer one libtest argument at a time — a bare name
 * filter, or a foldable harness flag — or returns null at the first argument
 * that is neither. `--test-threads` may take its value as the next token, so
 * every entry records where it ends. The single source of what a composite
 * may carry: `classifyTestTrailer` sums it up, `filterInsertOffset` places
 * the followers' filters by it.
 */
const readTestTrailer = (passthrough: readonly string[]): readonly TrailerArgument[] | null => {
  const entries: TrailerArgument[] = [];
  for (let index = 0; index < passthrough.length; index += 1) {
    const argument = passthrough[index];
    if (argument === undefined) {
      continue;
    }
    if (!argument.startsWith('-')) {
      entries.push({ kind: 'filter', value: argument, end: index + 1 });
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
        entries.push({ kind: 'harness', value: `--test-threads=${value}`, end: index + 1 });
        break;
      }
      case '--exact':
      case '--nocapture':
        if (inlineValue !== undefined) {
          return null;
        }
        entries.push({ kind: 'harness', value: option, end: index + 1 });
        break;
      case '-q':
      case '--quiet':
        if (inlineValue !== undefined) {
          return null;
        }
        entries.push({ kind: 'harness', value: '--quiet', end: index + 1 });
        break;
      default:
        return null;
    }
  }
  return entries;
};

/**
 * Classifies a `cargo test` trailer for folding (#87, #97). The foldable
 * harness flags are deliberately few: `--test-threads=N` (also the two-token
 * `--test-threads N`), `--nocapture`, `--quiet` / `-q`, and `--exact`.
 * `--exact` folds because libtest applies it to every filter it OR-s, so a
 * composite over the union of the participants' filters still runs precisely
 * the union of their selections — provided every participant asked for it,
 * which the harness-set equality in `testSelectionsFold` enforces (a
 * substring filter would otherwise start matching whole names, or an exact
 * one substrings). Every other flag returns null and keeps the run out of
 * composites — `--skip`, `--ignored`, `--include-ignored`, `--list`,
 * `--format`, `--logfile`, or anything unmodeled changes which tests run or
 * what the run produces, and a composite would apply it to every
 * participant.
 */
export const classifyTestTrailer = (passthrough: readonly string[]): TestTrailer | null => {
  const entries = readTestTrailer(passthrough);
  if (entries === null) {
    return null;
  }
  const filters: string[] = [];
  const harness = new Set<string>();
  for (const entry of entries) {
    switch (entry.kind) {
      case 'filter':
        filters.push(entry.value);
        break;
      case 'harness':
        harness.add(entry.value);
        break;
      default: {
        const exhaustive: never = entry.kind;
        return exhaustive;
      }
    }
  }
  return { filters, harness: [...harness].sort((left, right) => left.localeCompare(right)) };
};

/**
 * Where a composite splices the followers' filters into the leader's
 * trailer: just past its last bare filter, so the leader's harness flags
 * keep trailing the filters they govern (`-- x::y z::w --exact`, not
 * `-- x::y --exact z::w`), or at its start when it has none. libtest reads
 * a free argument as a filter wherever it sits among the flags; the
 * position is for whoever reads the composite's argv, not for libtest.
 */
const filterInsertOffset = (passthrough: readonly string[]): number => {
  let offset = 0;
  for (const entry of readTestTrailer(passthrough) ?? []) {
    if (entry.kind === 'filter') {
      offset = entry.end;
    }
  }
  return offset;
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
 * That equality is also what keeps exact and substring matching apart
 * (#97): a run with `--exact` never joins a composite without it, nor the
 * reverse, since the shared flag would change how the other side's filters
 * match. Between participants naming different packages — the fold that
 * shares a compile — name filters may differ: the composite runs the union
 * of packages with the union of filters, so every participant's tests are
 * selected (plus, at most, other participants' filters matching names in
 * its packages; under `--exact`, only a same-named test in another
 * package). An unfiltered run never joins a filtered one, though: it asked
 * for every test in its packages, and any filter would narrow it.
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
 * targets and harness flags (`--exact` included: exact and substring
 * runs never mix, #97), while the name filters of participants naming
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
 * filterset already matches) go after `--`, spliced in right behind the
 * leader's own filters so its harness flags — `--exact`, `--nocapture`,
 * `--test-threads=N`, … — still come once, last, and unchanged
 * (`-- x::y --exact` + `z::w` → `-- x::y z::w --exact`). libtest OR-s every
 * free argument as a filter wherever it sits among the flags, so the order
 * only serves the reader. `batchCompatibleFor` admits only followers whose
 * targets, harness flags, and compile surface already match the leader's.
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
  const passthroughAt = withNoFailFast.indexOf('--');
  if (passthroughAt === -1) {
    return [...withNoFailFast, '--', ...extraFilters];
  }
  const filtersEnd =
    passthroughAt + 1 + filterInsertOffset(withNoFailFast.slice(passthroughAt + 1));
  return [
    ...withNoFailFast.slice(0, filtersEnd),
    ...extraFilters,
    ...withNoFailFast.slice(filtersEnd),
  ];
};
