import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { describe, expect, it } from 'effect-rstest';
import * as Effect from 'effect/Effect';

import { createKacheStatus, readKacheStatusSnapshot } from '../src/daemon/kache-status.js';

describe('readKacheStatusSnapshot', () => {
  it('aggregates one index scan and a bounded event tail into status and priors', () => {
    const root = mkdtempSync(join(tmpdir(), 'cc-kache-status-'));
    const indexPath = join(root, 'index.db');
    const eventsPath = join(root, 'events.jsonl');
    const nowMs = Date.parse('2026-09-01T12:00:00.000Z');
    try {
      const database = new DatabaseSync(indexPath);
      database.exec(
        'CREATE TABLE entries (crate_name TEXT, profile TEXT, compile_time_ms INTEGER)',
      );
      const insert = database.prepare(
        'INSERT INTO entries (crate_name, profile, compile_time_ms) VALUES (?, ?, ?)',
      );
      insert.run('alpha', 'dev', 100);
      insert.run('alpha', 'dev', 300);
      insert.run('beta', 'release', 2_000);
      insert.run('gamma', 'debug', 1_000);
      database.close();

      const event = (offsetMs: number, value: Readonly<Record<string, unknown>>): string =>
        JSON.stringify({ ts: new Date(nowMs - offsetMs).toISOString(), ...value });
      writeFileSync(
        eventsPath,
        [
          'discarded'.repeat(1_000),
          event(10 * 60_000, { crate_name: 'old', event: 'heartbeat', root: '/old' }),
          event(4_000, { crate_name: 'alpha', event: 'heartbeat', root: '/work/a' }),
          event(3_000, { crate_name: 'beta', event: 'heartbeat', root: '/work/a' }),
          event(2_000, { crate_name: 'gamma', event: 'heartbeat', root: '/work/b' }),
          event(1_000, { crate_name: 'beta', compile_time_ms: 2_100, profile: 'release' }),
          '{malformed',
        ].join('\n'),
      );

      const snapshot = readKacheStatusSnapshot(indexPath, {
        maxEventBytes: 2_048,
        nowMs,
      });

      expect(snapshot.status).toEqual({
        available: true,
        distinctCrates: 3,
        entryCount: 4,
        eventsFreshMs: 1_000,
        indexSizeBytes: expect.any(Number),
        recentHeartbeatRoots: [
          { count: 2, root: '/work/a' },
          { count: 1, root: '/work/b' },
        ],
        topCrates: [
          { crate: 'beta', ms: 2_000, profile: 'release' },
          { crate: 'gamma', ms: 1_000, profile: 'debug' },
          { crate: 'alpha', ms: 300, profile: 'dev' },
        ],
      });
      expect(snapshot.status.indexSizeBytes).toBeGreaterThan(0);
      expect(snapshot.eventPriors.bytesRead).toBeLessThanOrEqual(2_048);
      expect(snapshot.indexPriors.compileTimeMs('alpha', ['dev'])).toBe(300);
      expect(snapshot.eventPriors.compileTimeMs('beta', ['release'])).toBe(2_100);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('caps slowest crates per profile instead of ranking across profiles', () => {
    const root = mkdtempSync(join(tmpdir(), 'cc-kache-status-profiles-'));
    const indexPath = join(root, 'index.db');
    try {
      const database = new DatabaseSync(indexPath);
      database.exec(
        'CREATE TABLE entries (crate_name TEXT, profile TEXT, compile_time_ms INTEGER)',
      );
      const insert = database.prepare(
        'INSERT INTO entries (crate_name, profile, compile_time_ms) VALUES (?, ?, ?)',
      );
      // Seven release timings, all slower than every dev timing: a global
      // top-N would evict dev entirely.
      for (let index = 0; index < 7; index += 1) {
        insert.run(`release-${index}`, 'release', 100_000 - index);
      }
      insert.run('dev-a', 'dev', 900);
      insert.run('dev-b', 'dev', 800);
      database.close();

      const { status } = readKacheStatusSnapshot(indexPath, { nowMs: 1_000 });
      const byProfile = new Map<string, number>();
      for (const row of status.topCrates) {
        byProfile.set(row.profile, (byProfile.get(row.profile) ?? 0) + 1);
      }
      expect(byProfile.get('release')).toBe(5);
      expect(byProfile.get('dev')).toBe(2);
      expect(status.topCrates.map((row) => row.crate)).toContain('dev-b');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports an unavailable configured index without throwing', () => {
    const root = mkdtempSync(join(tmpdir(), 'cc-kache-status-missing-'));
    try {
      const snapshot = readKacheStatusSnapshot(join(root, 'missing.db'), { nowMs: 1_000 });
      expect(snapshot.status.available).toBe(false);
      expect(snapshot.status.entryCount).toBe(0);
      expect(snapshot.status.topCrates).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports unavailable when the index file is not a SQLite database', () => {
    const root = mkdtempSync(join(tmpdir(), 'cc-kache-status-corrupt-'));
    const indexPath = join(root, 'index.db');
    try {
      writeFileSync(indexPath, 'not a sqlite database at all');
      const snapshot = readKacheStatusSnapshot(indexPath, { nowMs: 1_000 });
      expect(snapshot.status.available).toBe(false);
      expect(snapshot.indexPriors.compileTimeMs('alpha', ['dev'])).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports unavailable on schema drift without losing event priors', () => {
    const root = mkdtempSync(join(tmpdir(), 'cc-kache-status-schema-'));
    const indexPath = join(root, 'index.db');
    const nowMs = Date.parse('2026-09-01T12:00:00.000Z');
    try {
      const database = new DatabaseSync(indexPath);
      database.exec('CREATE TABLE entries (crate_name TEXT)');
      database.close();
      writeFileSync(
        join(root, 'events.jsonl'),
        `${JSON.stringify({
          ts: new Date(nowMs - 1_000).toISOString(),
          crate_name: 'alpha',
          profile: 'dev',
          compile_time_ms: 3_000,
        })}\n`,
      );
      const snapshot = readKacheStatusSnapshot(indexPath, { nowMs });
      expect(snapshot.status.available).toBe(false);
      expect(snapshot.indexPriors.compileTimeMs('alpha', ['dev'])).toBeNull();
      // The events sidecar is independent of index health.
      expect(snapshot.eventPriors.compileTimeMs('alpha', ['dev'])).toBe(3_000);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('createKacheStatus', () => {
  it.effect('serves null status and empty priors when disabled via an empty path', () =>
    Effect.gen(function* () {
      const service = createKacheStatus({ indexPath: '' });
      yield* service.prewarm;
      const status = yield* service.current;
      const priors = yield* service.priors;
      expect(status).toBeNull();
      expect(priors.indexPriors.compileTimeMs('alpha', ['dev'])).toBeNull();
      expect(priors.eventPriors.sampleCount).toBe(0);
    }));

  it.live('degrades to unavailable when the index disappears after daemon start', () =>
    Effect.gen(function* () {
      const root = yield* Effect.acquireRelease(
        Effect.sync(() => mkdtempSync(join(tmpdir(), 'cc-kache-status-midrun-'))),
        (directory) => Effect.sync(() => rmSync(directory, { recursive: true, force: true })),
      );
      const indexPath = join(root, 'index.db');
      const database = new DatabaseSync(indexPath);
      database.exec(
        'CREATE TABLE entries (crate_name TEXT, profile TEXT, compile_time_ms INTEGER)',
      );
      database
        .prepare('INSERT INTO entries (crate_name, profile, compile_time_ms) VALUES (?, ?, ?)')
        .run('alpha', 'dev', 1_000);
      database.close();

      let nowMs = 0;
      const service = createKacheStatus({
        indexPath,
        now: () => nowMs,
        ttlMs: 100,
      });
      yield* service.prewarm;
      const healthy = yield* service.current;
      expect(healthy?.available).toBe(true);

      rmSync(root, { recursive: true, force: true });
      nowMs = 200;
      // The first stale read serves the cached snapshot and forks a refresh.
      yield* service.current;
      yield* Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            setImmediate(resolve);
          }),
      );

      const degraded = yield* service.current;
      expect(degraded?.available).toBe(false);
      const priors = yield* service.priors;
      expect(priors.indexPriors.compileTimeMs('alpha', ['dev'])).toBeNull();
    }));
});
