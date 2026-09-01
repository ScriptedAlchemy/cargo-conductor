import { sameCompileSurface } from './coverage.js';
import type { NormalizedCargoIntent } from './intent-normalizer.js';

/** Subcommands whose invocations may be merged into one multi-package run. */
const batchableSubcommands = new Set(['build', 'check', 'clippy']);

/** Upper bound on packages merged into one composite invocation. */
export const maxBatchPackages = 16;

const stringArraysEqual = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);

/** Whether an intent has the explicit-package shape composable into a batch. */
export const batchLeaderEligible = (intent: NormalizedCargoIntent): boolean =>
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

const namedPackagesInArgv = (argv: readonly string[]): Set<string> => {
  const named = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const part = argv[index];
    if (part === '-p' || part === '--package') {
      const name = argv[index + 1];
      if (name !== undefined) {
        named.add(name);
      }
      continue;
    }
    if (part !== undefined && part.startsWith('--package=')) {
      named.add(part.slice('--package='.length));
    }
  }
  return named;
};

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
