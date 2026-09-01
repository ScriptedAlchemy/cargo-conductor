import { sameCompileSurface } from './coverage.js';
import type { NormalizedCargoIntent } from './intent-normalizer.js';

/** Compile-only subcommands whose package sets can share one cargo invocation. */
const batchableSubcommands = new Set(['build', 'check', 'clippy']);

const stringArraysEqual = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);

/**
 * Two queued intents can share one cargo process when they ask for the same
 * compile surface (profile/features/toolchain/env) and only differ in `-p`.
 * Workspace-wide, default-package, test, and opaque-flag work stays unmerged:
 * we cannot name the default package without metadata, and test execution is
 * never shared (plan B).
 */
export const batchCompatible = (
  left: NormalizedCargoIntent,
  right: NormalizedCargoIntent,
): boolean => {
  if (left.subcommand !== right.subcommand || !batchableSubcommands.has(left.subcommand)) {
    return false;
  }
  if (left.workspace || right.workspace) {
    return false;
  }
  if (left.packages.length === 0 || right.packages.length === 0) {
    return false;
  }
  if (
    left.opaqueArguments.length > 0 ||
    right.opaqueArguments.length > 0 ||
    left.passthrough.length > 0 ||
    right.passthrough.length > 0
  ) {
    return false;
  }
  if (!sameCompileSurface(left, right)) {
    return false;
  }
  return stringArraysEqual(left.targets, right.targets);
};

export const extraPackagesFor = (
  leader: NormalizedCargoIntent,
  follower: NormalizedCargoIntent,
): readonly string[] => follower.packages.filter((name) => !leader.packages.includes(name));

/**
 * Inserts `-p` flags for packages the leader argv does not already name.
 * Keeps `--message-format` and `--` passthrough at the tail so demux and
 * rustc args stay well-formed.
 */
export const withExtraPackages = (
  argv: readonly string[],
  packages: readonly string[],
): string[] => {
  const present = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '-p' || token === '--package') {
      const name = argv[index + 1];
      if (name !== undefined && !name.startsWith('-')) {
        present.add(name);
      }
    }
    if (token !== undefined && (token.startsWith('--package=') || token.startsWith('-p='))) {
      present.add(token.slice(token.indexOf('=') + 1));
    }
  }
  const extra = packages.filter((name) => name.length > 0 && !present.has(name));
  if (extra.length === 0) {
    return [...argv];
  }
  const flags = extra.flatMap((name) => ['-p', name]);
  const messageIndex = argv.findIndex((token) => token.startsWith('--message-format'));
  const passthroughIndex = argv.indexOf('--');
  const cut =
    messageIndex !== -1
      ? messageIndex
      : passthroughIndex !== -1
        ? passthroughIndex
        : argv.length;
  return [...argv.slice(0, cut), ...flags, ...argv.slice(cut)];
};
