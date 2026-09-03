import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { resolveHookStateDir } from './paths.js';
import { isRecord } from './shared.js';

/**
 * On-disk shape of `hook-state.json`, shared by every session's hooks.
 * `cursors` and `denies` are the original flat maps; `denyOwners` (ticket →
 * session) was added so a session can prune the counters it created without
 * touching another session's. Older files without it still load.
 */
interface HookState {
  readonly cursors: Record<string, number>;
  readonly denies: Record<string, number>;
  readonly denyOwners: Record<string, string>;
}

const statePath = (stateDir: string): string => join(stateDir, 'hook-state.json');

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
  const serialized: Record<string, unknown> = { cursors: state.cursors, denies: state.denies };
  if (Object.keys(state.denyOwners).length > 0) {
    serialized.denyOwners = state.denyOwners;
  }
  try {
    writeFileSync(temp, `${JSON.stringify(serialized)}\n`);
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
  const state = loadState(stateDir);
  state.cursors[session] = atMs;
  saveState(stateDir, state);
};

export const readDenyCount = (ticket: string, stateDir: string = resolveHookStateDir()): number =>
  loadState(stateDir).denies[ticket] ?? 0;

export const incrementDenyCount = (
  ticket: string,
  stateDir: string = resolveHookStateDir(),
  session?: string,
): number => {
  const state = loadState(stateDir);
  const next = (state.denies[ticket] ?? 0) + 1;
  state.denies[ticket] = next;
  if (session !== undefined) {
    state.denyOwners[ticket] = session;
  }
  saveState(stateDir, state);
  return next;
};

/**
 * Drop deny counters this session created for tickets that are no longer
 * pending (`keep` is the session's current hold-stop set). Counters owned by
 * other sessions are untouched; counters with no recorded owner predate
 * ownership tracking and are dropped once they fall outside `keep`.
 */
export const pruneDenyCounts = (
  session: string,
  keep: readonly string[],
  stateDir: string = resolveHookStateDir(),
): void => {
  const state = loadState(stateDir);
  const kept = new Set(keep);
  let changed = false;
  for (const ticket of Object.keys(state.denies)) {
    const owner = state.denyOwners[ticket];
    if (kept.has(ticket) || (owner !== undefined && owner !== session)) {
      continue;
    }
    delete state.denies[ticket];
    delete state.denyOwners[ticket];
    changed = true;
  }
  if (changed) {
    saveState(stateDir, state);
  }
};
