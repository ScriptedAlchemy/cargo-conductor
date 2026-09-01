import type { NormalizedCargoIntent } from './intent-normalizer.js';
import type { AttachMode } from './protocol.js';

/**
 * How a request may attach to an in-flight leader:
 * - 'identity': byte-identical normalized intent; the follower replays the
 *   leader's output and mirrors its result (including failure).
 * - 'coverage': the follower is a strictly weaker compile-only request whose
 *   success is proven by the leader's success. A failed or killed leader
 *   never satisfies a coverage follower (the failed-stronger rule): it is
 *   requeued to run on its own.
 */
export type { AttachMode };

/**
 * Subcommands safe to coalesce when the normalized intent is identical.
 * `run`/`install`/`publish`/dependency-mutating subcommands are excluded:
 * replaying their output does not reproduce their side effects per caller.
 * `test`/`nextest`/`bench` coalesce ONLY at identity — test execution is
 * never shared across different scopes.
 */
const identityCoalescable = new Set([
  'bench',
  'build',
  'check',
  'clippy',
  'doc',
  'fmt',
  'nextest',
  'test',
]);

/** Weaker subcommands eligible to ride a stronger in-flight compile. */
const coverageWeaker = new Set(['check']);

/**
 * Stronger subcommands whose success proves a covered weaker request.
 * `build` does strictly more work than `check` over the same surface;
 * `clippy`/`doc`/`test` are excluded (different diagnostics or extra
 * execution semantics).
 */
const coverageStronger = new Set(['build', 'check']);

const stringArraysEqual = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);

const isSubset = (subset: readonly string[], superset: readonly string[]): boolean =>
  subset.every((value) => superset.includes(value));

/**
 * The compile surface that must match EXACTLY for coverage: any difference
 * in feature resolution, profile, toolchain, target triple, or compilation
 * environment produces different artifacts and different diagnostics.
 */
export const sameCompileSurface = (
  left: NormalizedCargoIntent,
  right: NormalizedCargoIntent,
): boolean =>
  left.workspaceRoot === right.workspaceRoot &&
  left.targetDir === right.targetDir &&
  left.toolchain === right.toolchain &&
  left.envDigest === right.envDigest &&
  left.profile === right.profile &&
  left.targetTriple === right.targetTriple &&
  left.allFeatures === right.allFeatures &&
  left.noDefaultFeatures === right.noDefaultFeatures &&
  stringArraysEqual(left.features, right.features) &&
  (left.manifestPath ?? '') === (right.manifestPath ?? '');

/** Package-set cover: every package the weaker request compiles is compiled by the stronger one. */
const packagesCovered = (
  stronger: NormalizedCargoIntent,
  weaker: NormalizedCargoIntent,
): boolean => {
  if (stronger.workspace) {
    if (weaker.workspace) {
      // A workspace-wide weaker request is covered only when the stronger
      // run excludes nothing the weaker run would include.
      return isSubset(stronger.excludes, weaker.excludes);
    }
    if (weaker.packages.length === 0) {
      // Default-package weaker request: the cwd package is in the workspace
      // and not excluded only if nothing is excluded (we cannot name the
      // default package without cargo metadata).
      return stronger.excludes.length === 0;
    }
    return weaker.packages.every((name) => !stronger.excludes.includes(name));
  }
  if (weaker.workspace) {
    return false;
  }
  if (weaker.packages.length === 0) {
    // Both default-package invocations: identical only when launched from
    // the same directory (the default package is cwd-dependent).
    return stronger.packages.length === 0 && stronger.cwd === weaker.cwd;
  }
  return weaker.packages.length > 0 && isSubset(weaker.packages, stronger.packages);
};

/** Default (empty) target selection compiles the lib and every bin. */
const coveredByDefaultTargets = (target: string): boolean =>
  target === 'lib' || target === 'bins' || target.startsWith('bin:');

/** Target cover: `--all-targets` covers everything; empty = default lib+bins. */
const targetsCovered = (
  stronger: NormalizedCargoIntent,
  weaker: NormalizedCargoIntent,
): boolean => {
  if (stronger.targets.includes('all-targets')) {
    return true;
  }
  if (stronger.targets.length === 0) {
    return weaker.targets.length === 0 || weaker.targets.every(coveredByDefaultTargets);
  }
  if (weaker.targets.length === 0) {
    return false;
  }
  return isSubset(weaker.targets, stronger.targets);
};

/**
 * Decides whether `candidate` may attach to the in-flight `leader`.
 * Identity wins over coverage. Opaque (unrecognized) arguments and rustc
 * passthrough disqualify coverage entirely — we cannot reason about flags we
 * did not model — while identity remains safe because the full normalized
 * argv surface (opaque arguments included) feeds the intent key.
 */
export const attachModeFor = (
  leader: NormalizedCargoIntent,
  candidate: NormalizedCargoIntent,
): AttachMode | null => {
  if (leader.key === candidate.key && identityCoalescable.has(candidate.subcommand)) {
    return 'identity';
  }
  if (!coverageWeaker.has(candidate.subcommand) || !coverageStronger.has(leader.subcommand)) {
    return null;
  }
  if (
    leader.opaqueArguments.length > 0 ||
    candidate.opaqueArguments.length > 0 ||
    leader.passthrough.length > 0 ||
    candidate.passthrough.length > 0
  ) {
    return null;
  }
  if (!sameCompileSurface(leader, candidate)) {
    return null;
  }
  if (!packagesCovered(leader, candidate)) {
    return null;
  }
  if (!targetsCovered(leader, candidate)) {
    return null;
  }
  return 'coverage';
};
