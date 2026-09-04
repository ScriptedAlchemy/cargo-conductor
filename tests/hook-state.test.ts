import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  it('round-trips cursors and deny counters in the flat legacy shape', () => {
    withStateDir((directory) => {
      writeCursor('sess-1', 42, directory);
      expect(incrementDenyCount('cc-7', directory)).toBe(1);
      expect(incrementDenyCount('cc-7', directory)).toBe(2);

      expect(readCursor('sess-1', directory)).toBe(42);
      expect(readCursor('sess-2', directory)).toBe(0);
      expect(readDenyCount('cc-7', directory)).toBe(2);
      expect(readDenyCount('cc-8', directory)).toBe(0);
      expect(readState(directory)).toEqual({ cursors: { 'sess-1': 42 }, denies: { 'cc-7': 2 } });
    });
  });

  it('reads a file written by the previous release and tolerates garbage', () => {
    withStateDir((directory) => {
      writeFileSync(join(directory, 'hook-state.json'), '{"cursors":{"s":5},"denies":{"cc-1":3,"bad":"x"}}\n');
      expect(readCursor('s', directory)).toBe(5);
      expect(readDenyCount('cc-1', directory)).toBe(3);
      expect(readDenyCount('bad', directory)).toBe(0);

      writeFileSync(join(directory, 'hook-state.json'), '{not json');
      expect(readCursor('s', directory)).toBe(0);
      writeCursor('s', 6, directory);
      expect(readState(directory)).toEqual({ cursors: { s: 6 }, denies: {} });
    });
  });

  it('writes through a temp file and rename, leaving no temp files behind', () => {
    withStateDir((directory) => {
      writeCursor('sess-1', 1, directory);
      incrementDenyCount('cc-1', directory);
      expect(readdirSync(directory)).toEqual(['hook-state.json']);
    });
  });

  it('prunes only this session\'s deny counters that are no longer pending', () => {
    withStateDir((directory) => {
      incrementDenyCount('cc-1', directory, 'sess-1');
      incrementDenyCount('cc-2', directory, 'sess-1');
      incrementDenyCount('cc-3', directory, 'sess-2');
      // A counter written by the previous release carries no owner.
      incrementDenyCount('cc-0', directory);
      writeCursor('sess-1', 9, directory);
      expect(readState(directory)).toEqual({
        cursors: { 'sess-1': 9 },
        denies: { 'cc-0': 1, 'cc-1': 1, 'cc-2': 1, 'cc-3': 1 },
        denyOwners: { 'cc-1': 'sess-1', 'cc-2': 'sess-1', 'cc-3': 'sess-2' },
      });

      pruneDenyCounts('sess-1', ['cc-2'], directory);

      // cc-3 belongs to another session and is untouched; the ownerless
      // legacy counter is dropped once it is not pending for the pruning session.
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
