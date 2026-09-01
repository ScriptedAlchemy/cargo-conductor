import { readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as ChildProcess from 'effect/unstable/process/ChildProcess';
import * as ChildProcessSpawner from 'effect/unstable/process/ChildProcessSpawner';

import { realCargoBin } from './real-cargo.js';

export interface TopologyApi {
  /**
   * True when any of `packages` in `workspaceRoot` was edited within the
   * fail-fast window. Unknown workspaces/packages report false: the boost
   * is an optimization, never a correctness input.
   */
  readonly editedRecently: (
    workspaceRoot: string,
    packages: readonly string[],
  ) => Effect.Effect<boolean>;
  /**
   * Transitive workspace-internal dependencies of `packages` (the packages
   * themselves excluded). Unknown workspaces/packages report empty: the
   * scheduler treats the closure as an optimization signal only.
   */
  readonly dependencyClosure: (
    workspaceRoot: string,
    packages: readonly string[],
  ) => Effect.Effect<ReadonlySet<string>>;
}

export class Topology extends Context.Service<Topology, TopologyApi>()(
  'cargo-conductor/Topology',
) {}

const metadataTtlMs = 60_000;
const editStatTtlMs = 10_000;
const editWindowMs = 5 * 60_000;
const metadataTimeoutMs = 5_000;

export interface WorkspaceMetadata {
  readonly packageDirs: ReadonlyMap<string, string>;
  /** Direct dependencies per package, filtered to workspace members. */
  readonly directDeps: ReadonlyMap<string, ReadonlySet<string>>;
}

const emptyMetadata: WorkspaceMetadata = {
  packageDirs: new Map(),
  directDeps: new Map(),
};

interface MetadataCacheEntry {
  readonly atMs: number;
  readonly metadata: WorkspaceMetadata;
}

interface EditCacheEntry {
  readonly atMs: number;
  readonly edited: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Parses `cargo metadata --no-deps` output into the workspace-internal
 * dependency graph: `--no-deps` still lists each member's manifest-declared
 * `dependencies`, which is exactly the intra-workspace edge set once
 * filtered to member names. Exported for unit tests.
 */
export const parseWorkspaceMetadata = (stdout: string): WorkspaceMetadata => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return emptyMetadata;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.packages)) {
    return emptyMetadata;
  }
  const dirs = new Map<string, string>();
  const declaredDeps = new Map<string, string[]>();
  for (const entry of parsed.packages) {
    if (
      !isRecord(entry) ||
      typeof entry.name !== 'string' ||
      typeof entry.manifest_path !== 'string'
    ) {
      continue;
    }
    dirs.set(entry.name, dirname(entry.manifest_path));
    const names: string[] = [];
    if (Array.isArray(entry.dependencies)) {
      for (const dependency of entry.dependencies) {
        if (isRecord(dependency) && typeof dependency.name === 'string') {
          names.push(dependency.name);
        }
      }
    }
    declaredDeps.set(entry.name, names);
  }
  const directDeps = new Map<string, ReadonlySet<string>>();
  for (const [name, names] of declaredDeps) {
    directDeps.set(name, new Set(names.filter((dependency) => dirs.has(dependency))));
  }
  return { packageDirs: dirs, directDeps };
};

/** Transitive workspace deps of `packages` (themselves excluded). Exported for unit tests. */
export const workspaceClosure = (
  metadata: WorkspaceMetadata,
  packages: readonly string[],
): ReadonlySet<string> => {
  const closure = new Set<string>();
  const queue = [...packages];
  while (queue.length > 0) {
    const name = queue.pop();
    if (name === undefined) {
      break;
    }
    for (const dependency of metadata.directDeps.get(name) ?? []) {
      if (!closure.has(dependency)) {
        closure.add(dependency);
        queue.push(dependency);
      }
    }
  }
  for (const name of packages) {
    closure.delete(name);
  }
  return closure;
};

const editScanMaxEntries = 600;
const editScanSkipDirs = new Set(['target', 'node_modules']);

/**
 * Newest mtime under the package. Editing an existing file does not change
 * its directory's mtime, so this walks files (bounded, cached by the caller's
 * TTL) instead of stat-ing the src directory. Exported for unit tests.
 */
export const newestMtimeMs = (packageDir: string): number | null => {
  let newest: number | null = null;
  let budget = editScanMaxEntries;
  const consider = (path: string): void => {
    try {
      const mtime = statSync(path).mtimeMs;
      newest = newest === null ? mtime : Math.max(newest, mtime);
    } catch {
      // Missing entries are fine; a package may have no src directory.
    }
  };
  consider(join(packageDir, 'Cargo.toml'));
  consider(join(packageDir, 'build.rs'));
  const stack = [join(packageDir, 'src'), join(packageDir, 'tests')];
  while (stack.length > 0 && budget > 0) {
    const dir = stack.pop();
    if (dir === undefined) {
      break;
    }
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (budget <= 0) {
        break;
      }
      budget -= 1;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!editScanSkipDirs.has(entry.name) && !entry.name.startsWith('.')) {
          stack.push(path);
        }
        continue;
      }
      consider(path);
    }
  }
  return newest;
};

export const TopologyLive: Layer.Layer<Topology, never, ChildProcessSpawner.ChildProcessSpawner> =
  Layer.effect(
    Topology,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const scope = yield* Effect.scope;
      const metadataCache = new Map<string, MetadataCacheEntry>();
      const editCache = new Map<string, EditCacheEntry>();
      const refreshing = new Set<string>();

      // cargo metadata --no-deps --offline reads manifests only: no build
      // locks, no registry access. Failures cache an empty map for the TTL.
      const refreshMetadata = (workspaceRoot: string): Effect.Effect<void> =>
        Effect.gen(function* () {
          const stdout = yield* spawner
            .string(
              ChildProcess.make(
                realCargoBin(),
                ['metadata', '--format-version', '1', '--no-deps', '--offline'],
                { cwd: workspaceRoot },
              ),
            )
            .pipe(
              Effect.timeout(metadataTimeoutMs),
              Effect.catch(() => Effect.succeed('')),
            );
          yield* Effect.sync(() => {
            metadataCache.set(workspaceRoot, {
              atMs: Date.now(),
              metadata: parseWorkspaceMetadata(stdout),
            });
            refreshing.delete(workspaceRoot);
          });
        });

      /**
       * Never blocks a submission: returns whatever is cached and refreshes
       * in a background fiber. Cold workspaces simply report no packages
       * until the first refresh lands — the boost is best-effort.
       */
      const workspaceMetadata = (workspaceRoot: string): Effect.Effect<WorkspaceMetadata> =>
        Effect.gen(function* () {
          const cached = metadataCache.get(workspaceRoot);
          const fresh = cached !== undefined && Date.now() - cached.atMs < metadataTtlMs;
          if (!fresh) {
            const shouldRefresh = yield* Effect.sync(() => {
              if (refreshing.has(workspaceRoot)) {
                return false;
              }
              refreshing.add(workspaceRoot);
              return true;
            });
            if (shouldRefresh) {
              yield* Effect.forkIn(refreshMetadata(workspaceRoot), scope);
            }
          }
          return cached?.metadata ?? emptyMetadata;
        });

      const editedRecently = (
        workspaceRoot: string,
        packages: readonly string[],
      ): Effect.Effect<boolean> =>
        Effect.gen(function* () {
          if (packages.length === 0) {
            return false;
          }
          const dirs = (yield* workspaceMetadata(workspaceRoot)).packageDirs;
          const nowMs = Date.now();
          for (const name of packages) {
            const packageDir = dirs.get(name);
            if (packageDir === undefined) {
              continue;
            }
            const cached = editCache.get(packageDir);
            if (cached !== undefined && nowMs - cached.atMs < editStatTtlMs) {
              if (cached.edited) {
                return true;
              }
              continue;
            }
            const newest = newestMtimeMs(packageDir);
            const edited = newest !== null && nowMs - newest < editWindowMs;
            editCache.set(packageDir, { atMs: nowMs, edited });
            if (edited) {
              return true;
            }
          }
          return false;
        });

      const dependencyClosure = (
        workspaceRoot: string,
        packages: readonly string[],
      ): Effect.Effect<ReadonlySet<string>> =>
        Effect.gen(function* () {
          if (packages.length === 0) {
            return new Set<string>();
          }
          const metadata = yield* workspaceMetadata(workspaceRoot);
          return workspaceClosure(metadata, packages);
        });

      return { editedRecently, dependencyClosure } satisfies TopologyApi;
    }),
  );
