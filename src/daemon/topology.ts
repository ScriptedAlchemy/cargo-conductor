import { statSync } from 'node:fs';
import { dirname, join } from 'node:path';

import * as Command from '@effect/platform/Command';
import * as CommandExecutor from '@effect/platform/CommandExecutor';
import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';

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
}

export class Topology extends Context.Tag('cargo-conductor/Topology')<Topology, TopologyApi>() {}

const metadataTtlMs = 60_000;
const editStatTtlMs = 10_000;
const editWindowMs = 5 * 60_000;
const metadataTimeoutMs = 5_000;

interface MetadataCacheEntry {
  readonly atMs: number;
  readonly packageDirs: ReadonlyMap<string, string>;
}

interface EditCacheEntry {
  readonly atMs: number;
  readonly edited: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const parsePackageDirs = (stdout: string): ReadonlyMap<string, string> => {
  const dirs = new Map<string, string>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return dirs;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.packages)) {
    return dirs;
  }
  for (const entry of parsed.packages) {
    if (
      isRecord(entry) &&
      typeof entry.name === 'string' &&
      typeof entry.manifest_path === 'string'
    ) {
      dirs.set(entry.name, dirname(entry.manifest_path));
    }
  }
  return dirs;
};

const newestMtimeMs = (packageDir: string): number | null => {
  let newest: number | null = null;
  for (const candidate of [join(packageDir, 'src'), join(packageDir, 'Cargo.toml')]) {
    try {
      const mtime = statSync(candidate).mtimeMs;
      newest = newest === null ? mtime : Math.max(newest, mtime);
    } catch {
      // Missing entries are fine; a package may have no src directory.
    }
  }
  return newest;
};

export const TopologyLive: Layer.Layer<Topology, never, CommandExecutor.CommandExecutor> =
  Layer.scoped(
    Topology,
    Effect.gen(function* () {
      const executor = yield* CommandExecutor.CommandExecutor;
      const scope = yield* Effect.scope;
      const metadataCache = new Map<string, MetadataCacheEntry>();
      const editCache = new Map<string, EditCacheEntry>();
      const refreshing = new Set<string>();

      // cargo metadata --no-deps --offline reads manifests only: no build
      // locks, no registry access. Failures cache an empty map for the TTL.
      const refreshMetadata = (workspaceRoot: string): Effect.Effect<void> =>
        Effect.gen(function* () {
          const stdout = yield* Command.string(
            Command.workingDirectory(
              Command.make(
                'cargo',
                'metadata',
                '--format-version',
                '1',
                '--no-deps',
                '--offline',
              ),
              workspaceRoot,
            ),
          ).pipe(
            Effect.provideService(CommandExecutor.CommandExecutor, executor),
            Effect.timeout(metadataTimeoutMs),
            Effect.catchAll(() => Effect.succeed('')),
          );
          yield* Effect.sync(() => {
            metadataCache.set(workspaceRoot, {
              atMs: Date.now(),
              packageDirs: parsePackageDirs(stdout),
            });
            refreshing.delete(workspaceRoot);
          });
        });

      /**
       * Never blocks a submission: returns whatever is cached and refreshes
       * in a background fiber. Cold workspaces simply report no packages
       * until the first refresh lands — the boost is best-effort.
       */
      const packageDirs = (workspaceRoot: string): Effect.Effect<ReadonlyMap<string, string>> =>
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
          return cached?.packageDirs ?? new Map<string, string>();
        });

      const editedRecently = (
        workspaceRoot: string,
        packages: readonly string[],
      ): Effect.Effect<boolean> =>
        Effect.gen(function* () {
          if (packages.length === 0) {
            return false;
          }
          const dirs = yield* packageDirs(workspaceRoot);
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

      return { editedRecently } satisfies TopologyApi;
    }),
  );
