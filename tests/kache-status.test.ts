import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { describe, expect, it } from '@rstest/core';

import { readKacheStatusSnapshot } from '../src/daemon/kache-status.js';

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
});
