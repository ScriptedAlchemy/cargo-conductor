import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'effect-rstest';

import {
  incrementDenyCount,
  pruneDenyCounts,
  readCursor,
  readDenyCount,
  writeCursor,
} from '../src/hooks/hook-state.js';

const withStateDir = (use: (directory: string) => void): void => {
  const directory = mkdtempSync(join(tmpdir(), 'cc-hook-state-'));
  try {
    use(directory);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
};

const readState = (directory: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(directory, 'hook-state.json'), 'utf8')) as Record<string, unknown>;

describe('hook-state.json', () => {
  it('round-trips cursors and session-owned deny counters', () => {
    withStateDir((directory) => {
      writeCursor('sess-1', 42, directory);
      expect(incrementDenyCount('cc-7', 'sess-1', directory)).toBe(1);
      expect(incrementDenyCount('cc-7', 'sess-1', directory)).toBe(2);

      expect(readCursor('sess-1', directory)).toBe(42);
      expect(readCursor('sess-2', directory)).toBe(0);
      expect(readDenyCount('cc-7', directory)).toBe(2);
      expect(readDenyCount('cc-8', directory)).toBe(0);
      expect(readState(directory)).toEqual({
        cursors: { 'sess-1': 42 },
        denies: { 'cc-7': 2 },
        denyOwners: { 'cc-7': 'sess-1' },
      });
    });
  });

  it('reads only the well-typed entries and treats garbage as empty', () => {
    withStateDir((directory) => {
      writeFileSync(
        join(directory, 'hook-state.json'),
        '{"cursors":{"s":5},"denies":{"cc-1":3,"bad":"x"},"denyOwners":{"cc-1":"s"}}\n',
      );
      expect(readCursor('s', directory)).toBe(5);
      expect(readDenyCount('cc-1', directory)).toBe(3);
      expect(readDenyCount('bad', directory)).toBe(0);

      writeFileSync(join(directory, 'hook-state.json'), '{not json');
      expect(readCursor('s', directory)).toBe(0);
      writeCursor('s', 6, directory);
      expect(readState(directory)).toEqual({ cursors: { s: 6 }, denies: {}, denyOwners: {} });
    });
  });

  it('writes through a temp file and rename, leaving no temp files behind', () => {
    withStateDir((directory) => {
      writeCursor('sess-1', 1, directory);
      incrementDenyCount('cc-1', 'sess-1', directory);
      expect(readdirSync(directory)).toEqual(['hook-state.json']);
    });
  });

  it("prunes only this session's deny counters that are no longer pending", () => {
    withStateDir((directory) => {
      incrementDenyCount('cc-1', 'sess-1', directory);
      incrementDenyCount('cc-2', 'sess-1', directory);
      incrementDenyCount('cc-3', 'sess-2', directory);
      writeCursor('sess-1', 9, directory);
      expect(readState(directory)).toEqual({
        cursors: { 'sess-1': 9 },
        denies: { 'cc-1': 1, 'cc-2': 1, 'cc-3': 1 },
        denyOwners: { 'cc-1': 'sess-1', 'cc-2': 'sess-1', 'cc-3': 'sess-2' },
      });

      pruneDenyCounts('sess-1', ['cc-2'], directory);

      // cc-3 belongs to another session and is untouched.
      expect(readState(directory)).toEqual({
        cursors: { 'sess-1': 9 },
        denies: { 'cc-2': 1, 'cc-3': 1 },
        denyOwners: { 'cc-2': 'sess-1', 'cc-3': 'sess-2' },
      });

      pruneDenyCounts('sess-1', [], directory);
      expect(readState(directory)).toEqual({
        cursors: { 'sess-1': 9 },
        denies: { 'cc-3': 1 },
        denyOwners: { 'cc-3': 'sess-2' },
      });
      expect(readDenyCount('cc-3', directory)).toBe(1);
    });
  });
});

describe('hook-state.json locking (#110)', () => {
  const lockDir = (directory: string): string => join(directory, 'hook-state.json.lock');

  it('holds the lock directory across a read-modify-write and releases it afterwards', () => {
    withStateDir((directory) => {
      // A lock appears when the update starts and is gone once it settled;
      // proper-lockfile's lock is a directory beside the file.
      writeCursor('sess-1', 1, directory);
      expect(readdirSync(directory)).toEqual(['hook-state.json']);
      expect(readCursor('sess-1', directory)).toBe(1);
    });
  });

  it('waits for a concurrent holder and then applies its own change on top', () => {
    withStateDir((directory) => {
      writeCursor('sess-1', 1, directory);
      // Another hook holds the lock: take it here, mutate the file the way
      // that hook would, and let it go stale rather than releasing, as a
      // hook killed mid-update would. The update must still land, and on
      // top of the other hook's write, not over it.
      mkdirSync(lockDir(directory));
      const staleAt = new Date(Date.now() - 60_000);
      utimesSync(lockDir(directory), staleAt, staleAt);
      writeFileSync(
        join(directory, 'hook-state.json'),
        `${JSON.stringify({ cursors: { 'sess-1': 1, 'sess-2': 7 }, denies: {}, denyOwners: {} })}\n`,
      );
      expect(incrementDenyCount('cc-9', 'sess-1', directory)).toBe(1);
      expect(readCursor('sess-2', directory)).toBe(7);
      expect(readDenyCount('cc-9', directory)).toBe(1);
      expect(existsSync(lockDir(directory))).toBe(false);
    });
  });

  it('degrades to an unlocked update instead of failing when the lock cannot be taken in time', () => {
    withStateDir((directory) => {
      writeCursor('sess-1', 1, directory);
      // A fresh (non-stale) lock held by a hook that never returns.
      mkdirSync(lockDir(directory));
      const startedAt = Date.now();
      writeCursor('sess-3', 3, directory);
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(1_500);
      expect(readCursor('sess-3', directory)).toBe(3);
      expect(readCursor('sess-1', directory)).toBe(1);
    });
  });
});
