import type { NormalizedCargoIntent } from './intent-normalizer.js';
import { attachRejectionGates } from './protocol.js';
import type { AttachMode, AttachRejectionGate } from './protocol.js';

/**
 * How a request may attach to an in-flight leader:
 * - 'identity': byte-identical normalized intent; the follower replays the
 *   leader's output and mirrors its result (including failure).
 * - 'coverage': the follower is a strictly weaker compile-only request whose
 *   success is proven by the leader's success. A failed or killed leader
 *   never satisfies a coverage follower (the failed-stronger rule): it is
 *   requeued to run on its own.
 */
export type { AttachMode, AttachRejectionGate };

/**
 * The outcome of asking whether one intent may ride another. A rejection
 * names the first gate the pair failed (gates are evaluated in the order of
 * `attachRejectionGates`) and a human-readable detail for the debug log.
 */
export type AttachDecision =
  | { readonly _tag: 'attach'; readonly mode: AttachMode }
  | { readonly _tag: 'rejected'; readonly gate: AttachRejectionGate; readonly detail: string };

const attach = (mode: AttachMode): AttachDecision => ({ _tag: 'attach', mode });
const rejected = (gate: AttachRejectionGate, detail: string): AttachDecision => ({
  _tag: 'rejected',
  gate,
  detail,
});

/** Position of a gate in evaluation order; a later gate is a nearer miss. */
export const attachRejectionRank = (gate: AttachRejectionGate): number =>
  attachRejectionGates.indexOf(gate);

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

/** Weaker compile-only subcommands eligible to ride a stronger in-flight compile. */
const compileWeaker = new Set(['check']);

/**
 * Stronger subcommands whose success proves a covered compile-only request.
 * `build` does strictly more work than `check` over the same surface;
 * `clippy`/`doc`/`test` are excluded (different diagnostics — a lint failure
 * under clippy would misreport a check — or extra execution semantics).
 */
const compileStronger = new Set(['build', 'check']);

/**
 * Subcommands whose `--no-run` spelling compiles exactly what the plain
 * invocation compiles and then executes nothing. Such a request's demand is
 * proven the moment a leader with the same compile surface reports its build
 * finished, whatever the leader then runs.
 */
const buildOnlySubcommands = new Set(['bench', 'test']);

/**
 * `cargo test`/`cargo bench` flags that only shape the execution phase —
 * whether the built binaries run at all, and whether one failing binary
 * stops the rest — never what compiles. They stay opaque in the intent
 * (they change what an invocation *does*, so identity keys must see them),
 * but a `--no-run` rider is indifferent to them on either side.
 */
const runPhaseArguments = new Set(['--no-fail-fast', '--no-run']);

/**
 * The two coverage shapes: a `check` riding a `build`/`check`, or a
 * `test --no-run`/`bench --no-run` riding a `test`/`bench` whose build
 * produces the rider's artifacts (#88).
 */
type CoverageShape = 'compile' | 'build-only';

/**
 * A `cargo test`/`cargo bench` request that compiles and executes nothing.
 * As a coverage rider its demand is proven by the leader's build alone, so
 * it is released when the leader reports its build finished rather than
 * when the leader's tests end; a leader whose build never reports finished
 * (`--quiet`, or overlap disabled) releases it at settlement instead.
 */
export const isBuildOnlyIntent = (intent: NormalizedCargoIntent): boolean =>
  buildOnlySubcommands.has(intent.subcommand) && intent.opaqueArguments.includes('--no-run');

const coverageShapeFor = (
  leader: NormalizedCargoIntent,
  candidate: NormalizedCargoIntent,
): CoverageShape | null => {
  if (compileWeaker.has(candidate.subcommand) && compileStronger.has(leader.subcommand)) {
    return 'compile';
  }
  if (isBuildOnlyIntent(candidate) && leader.subcommand === candidate.subcommand) {
    return 'build-only';
  }
  return null;
};

export const stringArraysEqual = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);

const isSubset = (subset: readonly string[], superset: readonly string[]): boolean =>
  subset.every((value) => superset.includes(value));

const withoutRunPhaseArguments = (arguments_: readonly string[]): readonly string[] =>
  arguments_.filter((argument) => !runPhaseArguments.has(argument));

/**
 * The compile surface that must match EXACTLY for coverage: any difference
 * in feature resolution, profile, toolchain, target triple, or compilation
 * environment produces different artifacts and different diagnostics.
 */
export const sameCompileSurface = (
  left: NormalizedCargoIntent,
  right: NormalizedCargoIntent,
): boolean => compileSurfaceDifference(left, right) === null;

/** The first compile-surface field that differs, for the rejection detail; null when equal. */
const compileSurfaceDifference = (
  left: NormalizedCargoIntent,
  right: NormalizedCargoIntent,
): string | null => {
  if (left.workspaceRoot !== right.workspaceRoot) {
    return 'workspace root';
  }
  if (left.targetDir !== right.targetDir) {
    return 'target dir';
  }
  if (left.toolchain !== right.toolchain) {
    return 'toolchain';
  }
  if (left.envDigest !== right.envDigest) {
    return 'compilation environment';
  }
  if (left.profile !== right.profile) {
    return 'profile';
  }
  if (left.targetTriple !== right.targetTriple) {
    return 'target triple';
  }
  if (
    left.allFeatures !== right.allFeatures ||
    left.noDefaultFeatures !== right.noDefaultFeatures ||
    !stringArraysEqual(left.features, right.features)
  ) {
    return 'features';
  }
  if ((left.manifestPath ?? '') !== (right.manifestPath ?? '')) {
    return 'manifest path';
  }
  return null;
};

/**
 * Package-set cover: every package the weaker request compiles is compiled
 * by the stronger one. Returns null when covered, else the reason.
 *
 * A stronger request without `-p` or `--workspace` compiles cargo's default
 * package set for its cwd: the whole workspace under a virtual manifest, the
 * root package alone when the root manifest is also a package. The intent
 * cannot tell the two apart, so a `-p` rider is not proven by it.
 */
const packagesUncovered = (
  stronger: NormalizedCargoIntent,
  weaker: NormalizedCargoIntent,
): string | null => {
  if (stronger.workspace) {
    if (weaker.workspace) {
      // A workspace-wide weaker request is covered only when the stronger
      // run excludes nothing the weaker run would include.
      return isSubset(stronger.excludes, weaker.excludes)
        ? null
        : `leader excludes ${stronger.excludes.filter((name) => !weaker.excludes.includes(name)).join(', ')}`;
    }
    if (weaker.packages.length === 0) {
      // Default-package weaker request: the cwd package is in the workspace
      // and not excluded only if nothing is excluded (we cannot name the
      // default package without cargo metadata).
      return stronger.excludes.length === 0
        ? null
        : 'leader excludes packages and the default package cannot be named';
    }
    const excluded = weaker.packages.filter((name) => stronger.excludes.includes(name));
    return excluded.length === 0 ? null : `leader excludes ${excluded.join(', ')}`;
  }
  if (weaker.workspace) {
    return 'leader is not workspace-wide';
  }
  if (weaker.packages.length === 0) {
    // Both default-package invocations: identical only when launched from
    // the same directory (the default package is cwd-dependent).
    if (stronger.packages.length > 0) {
      return 'leader names packages; the default package cannot be named';
    }
    return stronger.cwd === weaker.cwd ? null : 'default packages of different directories';
  }
  if (stronger.packages.length === 0) {
    return 'leader compiles its default package set, which cargo metadata alone could name';
  }
  const missing = weaker.packages.filter((name) => !stronger.packages.includes(name));
  return missing.length === 0 ? null : `leader does not compile ${missing.join(', ')}`;
};

/** Default (empty) target selection of `build`/`check` compiles the lib and every bin. */
const coveredByDefaultCompileTargets = (target: string): boolean =>
  target === 'lib' || target === 'bins' || target.startsWith('bin:');

/**
 * Whether one explicit target flag on the stronger side compiles a target
 * the weaker side names. `--all-targets` expands to lib, bins, tests,
 * benches, and examples (never doc tests); `--bins`/`--examples` compile
 * every target of their kind unconditionally. `--tests`/`--benches` are
 * NOT taken to cover a named `--test X`/`--bench X`: they select only
 * targets with `test = true`/`bench = true`, while the explicit flag builds
 * the target regardless.
 */
const explicitTargetCovers = (stronger: string, weaker: string): boolean =>
  stronger === weaker ||
  (stronger === 'all-targets' && weaker !== 'doc') ||
  (stronger === 'bins' && weaker.startsWith('bin:')) ||
  (stronger === 'examples' && weaker.startsWith('example:'));

/**
 * Target cover per shape. For a compile pair the default (empty) selection
 * is lib+bins, and `--all-targets` covers it. A `--no-run` rider's targets
 * must be an explicit subset of the leader's (`--lib` vs `--test foo` never
 * attach): the default test set depends on each target's `test = true`
 * flag, which the intent cannot see, so it covers only another default.
 */
const targetsUncovered = (
  stronger: NormalizedCargoIntent,
  weaker: NormalizedCargoIntent,
  shape: CoverageShape,
): string | null => {
  const describe = (targets: readonly string[]): string =>
    targets.length === 0 ? 'default targets' : targets.join(', ');
  const detail = `leader compiles ${describe(stronger.targets)}, rider needs ${describe(weaker.targets)}`;
  if (stronger.targets.length === 0) {
    switch (shape) {
      case 'compile':
        return weaker.targets.every(coveredByDefaultCompileTargets) ? null : detail;
      case 'build-only':
        return weaker.targets.length === 0 ? null : detail;
      default: {
        const exhaustive: never = shape;
        return exhaustive;
      }
    }
  }
  if (weaker.targets.length === 0) {
    return shape === 'compile' && stronger.targets.includes('all-targets') ? null : detail;
  }
  return weaker.targets.every((target) =>
    stronger.targets.some((strong) => explicitTargetCovers(strong, target)),
  )
    ? null
    : detail;
};

/**
 * Decides whether `candidate` may attach to the in-flight `leader`, naming
 * the gate that refused it otherwise. Identity wins over coverage.
 *
 * Unrecognized (opaque) arguments and rustc/libtest passthrough disqualify
 * coverage only when they differ: two invocations carrying the same
 * unmodeled flags behave the same way under them, so the stronger still
 * proves the weaker. A `--no-run` rider additionally ignores the flags and
 * passthrough that only select which tests run (#88): they compile nothing.
 */
export const attachDecisionFor = (
  leader: NormalizedCargoIntent,
  candidate: NormalizedCargoIntent,
): AttachDecision => {
  if (leader.key === candidate.key) {
    return identityCoalescable.has(candidate.subcommand)
      ? attach('identity')
      : rejected('subcommand', `cargo ${candidate.subcommand} is never shared, even when identical`);
  }
  const shape = coverageShapeFor(leader, candidate);
  if (shape === null) {
    return rejected(
      'subcommand',
      `cargo ${candidate.subcommand} cannot ride cargo ${leader.subcommand}`,
    );
  }
  const opaqueEqual =
    shape === 'build-only'
      ? stringArraysEqual(
          withoutRunPhaseArguments(leader.opaqueArguments),
          withoutRunPhaseArguments(candidate.opaqueArguments),
        )
      : stringArraysEqual(leader.opaqueArguments, candidate.opaqueArguments);
  if (!opaqueEqual) {
    return rejected(
      'opaque-arguments',
      `unmodeled flags differ: leader [${leader.opaqueArguments.join(' ')}], rider [${candidate.opaqueArguments.join(' ')}]`,
    );
  }
  if (shape === 'compile' && !stringArraysEqual(leader.passthrough, candidate.passthrough)) {
    return rejected(
      'passthrough',
      `arguments after -- differ: leader [${leader.passthrough.join(' ')}], rider [${candidate.passthrough.join(' ')}]`,
    );
  }
  const surface = compileSurfaceDifference(leader, candidate);
  if (surface !== null) {
    return rejected('compile-surface', `${surface} differs`);
  }
  const packages = packagesUncovered(leader, candidate);
  if (packages !== null) {
    return rejected('packages', packages);
  }
  const targets = targetsUncovered(leader, candidate, shape);
  if (targets !== null) {
    return rejected('targets', targets);
  }
  return attach('coverage');
};

/** The attach mode `candidate` may take on `leader`, or null when it may not attach. */
export const attachModeFor = (
  leader: NormalizedCargoIntent,
  candidate: NormalizedCargoIntent,
): AttachMode | null => {
  const decision = attachDecisionFor(leader, candidate);
  switch (decision._tag) {
    case 'attach':
      return decision.mode;
    case 'rejected':
      return null;
    default: {
      const exhaustive: never = decision;
      return exhaustive;
    }
  }
};
