import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from '@rstest/core';
import * as Data from 'effect/Data';
import * as Deferred from 'effect/Deferred';
import * as Effect from 'effect/Effect';

import {
  makeTopology,
  newestMtimeMs,
  parseWorkspaceMetadata,
  workspaceClosure,
} from '../src/daemon/topology.js';

const metadataJson = JSON.stringify({
  packages: [
    {
      name: 'leaf',
      manifest_path: '/ws/crates/leaf/Cargo.toml',
      dependencies: [{ name: 'serde' }],
    },
    {
      name: 'mid',
      manifest_path: '/ws/crates/mid/Cargo.toml',
      dependencies: [{ name: 'leaf' }, { name: 'tokio' }],
    },
    {
      name: 'top',
      manifest_path: '/ws/crates/top/Cargo.toml',
      dependencies: [{ name: 'mid' }],
    },
    {
      name: 'island',
      manifest_path: '/ws/crates/island/Cargo.toml',
      dependencies: [],
    },
  ],
});

class FixtureError extends Data.TaggedError('FixtureError')<{ readonly reason: string }> {}

describe('parseWorkspaceMetadata', () => {
  it('keeps only workspace-internal dependency edges', () => {
    const metadata = parseWorkspaceMetadata(metadataJson);
    expect([...(metadata.directDeps.get('mid') ?? [])]).toEqual(['leaf']);
    expect([...(metadata.directDeps.get('top') ?? [])]).toEqual(['mid']);
    expect(metadata.directDeps.get('leaf')?.size).toBe(0);
    expect(metadata.packageDirs.get('leaf')).toBe('/ws/crates/leaf');
  });

  it('returns an empty graph for malformed output', () => {
    expect(parseWorkspaceMetadata('').directDeps.size).toBe(0);
    expect(parseWorkspaceMetadata('{"no":"packages"}').packageDirs.size).toBe(0);
  });
});

describe('workspaceClosure', () => {
  const metadata = parseWorkspaceMetadata(metadataJson);

  it('computes the transitive closure excluding the requested packages', () => {
    expect([...workspaceClosure(metadata, ['top'])].sort()).toEqual(['leaf', 'mid']);
    expect([...workspaceClosure(metadata, ['mid'])]).toEqual(['leaf']);
    expect(workspaceClosure(metadata, ['leaf']).size).toBe(0);
    expect(workspaceClosure(metadata, ['island']).size).toBe(0);
  });

  it('unions closures across the requested set', () => {
    expect([...workspaceClosure(metadata, ['top', 'island'])].sort()).toEqual(['leaf', 'mid']);
  });
});

describe('newestMtimeMs', () => {
  it('sees edits to existing nested files, not just directory mtimes', () => {
    const root = mkdtempSync(join(tmpdir(), 'cc-topology-'));
    try {
      const src = join(root, 'src', 'nested');
      mkdirSync(src, { recursive: true });
      writeFileSync(join(root, 'Cargo.toml'), '[package]\n');
      writeFileSync(join(src, 'lib.rs'), 'fn old() {}\n');

      // Age everything, then "edit" the nested file in place: only its own
      // mtime moves — parent directory mtimes stay old.
      const oldSeconds = (Date.now() - 60 * 60 * 1000) / 1000;
      for (const path of [root, join(root, 'src'), src, join(root, 'Cargo.toml'), join(src, 'lib.rs')]) {
        utimesSync(path, oldSeconds, oldSeconds);
      }
      const editedSeconds = Date.now() / 1000;
      utimesSync(join(src, 'lib.rs'), editedSeconds, editedSeconds);
      for (const path of [root, join(root, 'src'), src]) {
        utimesSync(path, oldSeconds, oldSeconds);
      }

      const newest = newestMtimeMs(root);
      expect(newest).not.toBeNull();
      expect(newest!).toBeGreaterThan(editedSeconds * 1000 - 5_000);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns null for a directory with nothing to stat', () => {
    const root = mkdtempSync(join(tmpdir(), 'cc-topology-empty-'));
    try {
      expect(newestMtimeMs(join(root, 'missing-package'))).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/**
 * Effect v4 wakes Deferred awaiters before the completing fiber has run its
 * enclosing tap/ensuring steps, so makeTopology's cache writes and
 * refresh-slot bookkeeping land one fiber step after the load/scan signals
 * completion. Yield once so the next assertion observes the settled state.
 */
const awaitSettled = <A, E>(deferred: Deferred.Deferred<A, E>): Effect.Effect<A, E> =>
  Deferred.await(deferred).pipe(Effect.tap(() => Effect.yieldNow));

describe('makeTopology', () => {
  it('returns edit data immediately, refreshes in the background, and retries after failure', async () => {
    const packageDir = '/workspace/alpha';
    const metadataLoaded = Deferred.makeUnsafe<void>();
    const firstScanStarted = Deferred.makeUnsafe<void>();
    const releaseFirstScan = Deferred.makeUnsafe<void>();
    const firstScanFinished = Deferred.makeUnsafe<void>();
    const secondScanFinished = Deferred.makeUnsafe<void>();
    let scans = 0;
    const metadata = {
      packageDirs: new Map([['alpha', packageDir]]),
      directDeps: new Map<string, ReadonlySet<string>>([['alpha', new Set()]]),
    };

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const topology = yield* makeTopology({
            loadMetadata: () =>
              Deferred.succeed(metadataLoaded, undefined).pipe(Effect.as(metadata)),
            scanNewestMtime: () =>
              Effect.suspend(() => {
                scans += 1;
                if (scans === 1) {
                  return Deferred.succeed(firstScanStarted, undefined).pipe(
                    Effect.andThen(Deferred.await(releaseFirstScan)),
                    Effect.andThen(Effect.fail(new FixtureError({ reason: 'stat failed' }))),
                    Effect.ensuring(Deferred.succeed(firstScanFinished, undefined)),
                  );
                }
                return Deferred.succeed(secondScanFinished, undefined).pipe(
                  Effect.as(Date.now()),
                );
              }),
          });

          expect(yield* topology.editedRecently('/workspace', ['alpha'])).toBe(false);
          yield* awaitSettled(metadataLoaded);

          expect(yield* topology.editedRecently('/workspace', ['alpha'])).toBe(false);
          yield* awaitSettled(firstScanStarted);
          yield* Deferred.succeed(releaseFirstScan, undefined);
          yield* awaitSettled(firstScanFinished);

          expect(yield* topology.editedRecently('/workspace', ['alpha'])).toBe(false);
          yield* awaitSettled(secondScanFinished);

          expect(yield* topology.editedRecently('/workspace', ['alpha'])).toBe(true);
          expect(scans).toBe(2);
        }),
      ),
    );
  });

  it('clears metadata refresh bookkeeping after failure and caches only success', async () => {
    const firstLoadFinished = Deferred.makeUnsafe<void>();
    const secondLoadFinished = Deferred.makeUnsafe<void>();
    let loads = 0;
    const metadata = parseWorkspaceMetadata(metadataJson);

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const topology = yield* makeTopology({
            loadMetadata: () =>
              Effect.suspend(() => {
                loads += 1;
                if (loads === 1) {
                  return Effect.fail(new FixtureError({ reason: 'metadata failed' })).pipe(
                    Effect.ensuring(Deferred.succeed(firstLoadFinished, undefined)),
                  );
                }
                return Deferred.succeed(secondLoadFinished, undefined).pipe(
                  Effect.as(metadata),
                );
              }),
            scanNewestMtime: () => Effect.succeed(null),
          });

          expect((yield* topology.dependencyClosure('/ws', ['top'])).size).toBe(0);
          yield* awaitSettled(firstLoadFinished);

          expect((yield* topology.dependencyClosure('/ws', ['top'])).size).toBe(0);
          yield* awaitSettled(secondLoadFinished);

          expect([...(yield* topology.dependencyClosure('/ws', ['top']))].sort()).toEqual([
            'leaf',
            'mid',
          ]);
          expect(loads).toBe(2);
        }),
      ),
    );
  });
});
