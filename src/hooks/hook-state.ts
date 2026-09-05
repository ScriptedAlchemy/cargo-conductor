import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { lockSync } from 'proper-lockfile';

import { isRecord } from '../lib/guards.js';

import { resolveHookStateDir } from './paths.js';

/**
 * On-disk shape of `hook-state.json`, shared by every session's hooks:
 * `cursors` (session → last event cursor), `denies` (ticket → stop denials),
 * and `denyOwners` (ticket → session) so a session prunes only the counters
 * it created. A file that is missing, unreadable, or not this shape reads as
 * empty.
 */
interface HookState {
  readonly cursors: Record<string, number>;
  readonly denies: Record<string, number>;
  readonly denyOwners: Record<string, string>;
}

const statePath = (stateDir: string): string => join(stateDir, 'hook-state.json');

/** How long one hook may wait for another session's hook to finish its update. */
const lockWaitMs = 2_000;
const lockRetryMs = 10;
/** A lock older than this belongs to a hook that died mid-update and is taken over. */
const lockStaleMs = 5_000;

const sleepSync = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

/**
 * Serializes read-modify-write cycles on the shared state file across the
 * hook processes of every concurrent session (#110). Atomic rename keeps
 * readers from seeing a torn file, but two hooks that both load state,
 * apply their own change, and save would drop each other's: one session's
 * cursor or deny counter silently lost. The lock is a `.lock` directory
 * beside the file (proper-lockfile, the daemon singleton's mechanism);
 * hooks are short-lived, so waiting is bounded and a lock that cannot be
 * taken in time degrades to the previous unlocked update rather than
 * failing the host's tool call.
 */
const withStateLock = <A>(stateDir: string, update: () => A): A => {
  mkdirSync(stateDir, { recursive: true });
  const target = statePath(stateDir);
  if (!existsSync(target)) {
    // proper-lockfile locks an existing path; an absent state file reads as
    // empty either way.
    try {
      writeFileSync(target, `${JSON.stringify(emptyState())}\n`, { flag: 'wx' });
    } catch {
      // Another hook created it first; that is the file we lock.
    }
  }
  const deadline = Date.now() + lockWaitMs;
  let release: (() => void) | null = null;
  for (;;) {
    try {
      release = lockSync(target, { realpath: false, stale: lockStaleMs });
      break;
    } catch {
      if (Date.now() >= deadline) {
        break;
      }
      sleepSync(lockRetryMs);
    }
  }
  try {
    return update();
  } finally {
    try {
      release?.();
    } catch {
      // A lock the stale sweep already reclaimed has nothing left to release.
    }
  }
};

const emptyState = (): HookState => ({ cursors: {}, denies: {}, denyOwners: {} });

const numberEntries = (value: unknown): Record<string, number> =>
  isRecord(value)
    ? Object.fromEntries(
        Object.entries(value).filter((entry): entry is [string, number] => typeof entry[1] === 'number'),
      )
    : {};

const stringEntries = (value: unknown): Record<string, string> =>
  isRecord(value)
    ? Object.fromEntries(
        Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
      )
    : {};

const loadState = (stateDir: string): HookState => {
  const path = statePath(stateDir);
  if (!existsSync(path)) {
    return emptyState();
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!isRecord(parsed)) {
      return emptyState();
    }
    return {
      cursors: numberEntries(parsed.cursors),
      denies: numberEntries(parsed.denies),
      denyOwners: stringEntries(parsed.denyOwners),
    };
  } catch {
    return emptyState();
  }
};

/**
 * Write to a sibling temp file and rename over the target so a concurrent
 * reader (another session's hook) never sees a torn file. The rename is
 * atomic on POSIX and on Windows for same-volume paths.
 */
const saveState = (stateDir: string, state: HookState): void => {
  mkdirSync(stateDir, { recursive: true });
  const target = statePath(stateDir);
  const temp = `${target}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(state)}\n`);
    renameSync(temp, target);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
};

export const readCursor = (session: string, stateDir: string = resolveHookStateDir()): number =>
  loadState(stateDir).cursors[session] ?? 0;

export const writeCursor = (
  session: string,
  atMs: number,
  stateDir: string = resolveHookStateDir(),
): void => {
  withStateLock(stateDir, () => {
    const state = loadState(stateDir);
    state.cursors[session] = atMs;
    saveState(stateDir, state);
  });
};

export const readDenyCount = (ticket: string, stateDir: string = resolveHookStateDir()): number =>
  loadState(stateDir).denies[ticket] ?? 0;

/** Counts one more stop denial for `ticket` on behalf of `session`, which then owns the counter. */
export const incrementDenyCount = (
  ticket: string,
  session: string,
  stateDir: string = resolveHookStateDir(),
): number =>
  withStateLock(stateDir, () => {
    const state = loadState(stateDir);
    const next = (state.denies[ticket] ?? 0) + 1;
    state.denies[ticket] = next;
    state.denyOwners[ticket] = session;
    saveState(stateDir, state);
    return next;
  });

/**
 * Drop deny counters this session created for tickets that are no longer
 * pending (`keep` is the session's current hold-stop set). Counters owned by
 * any other session are untouched.
 */
export const pruneDenyCounts = (
  session: string,
  keep: readonly string[],
  stateDir: string = resolveHookStateDir(),
): void => {
  withStateLock(stateDir, () => {
    const state = loadState(stateDir);
    const kept = new Set(keep);
    let changed = false;
    for (const ticket of Object.keys(state.denies)) {
      if (kept.has(ticket) || state.denyOwners[ticket] !== session) {
        continue;
      }
      delete state.denies[ticket];
      delete state.denyOwners[ticket];
      changed = true;
    }
    if (changed) {
      saveState(stateDir, state);
    }
  });
};
