import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { resolveHookStateDir } from './paths.js';
import { isRecord } from './shared.js';

interface HookStateFile {
  readonly cursors?: Readonly<Record<string, number>>;
  readonly denies?: Readonly<Record<string, number>>;
}

const statePath = (stateDir: string): string => join(stateDir, 'hook-state.json');

const loadState = (stateDir: string): { cursors: Record<string, number>; denies: Record<string, number> } => {
  const path = statePath(stateDir);
  if (!existsSync(path)) {
    return { cursors: {}, denies: {} };
  }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as HookStateFile;
    const cursors = isRecord(parsed.cursors)
      ? Object.fromEntries(
          Object.entries(parsed.cursors).filter((entry): entry is [string, number] => typeof entry[1] === 'number'),
        )
      : {};
    const denies = isRecord(parsed.denies)
      ? Object.fromEntries(
          Object.entries(parsed.denies).filter((entry): entry is [string, number] => typeof entry[1] === 'number'),
        )
      : {};
    return { cursors, denies };
  } catch {
    return { cursors: {}, denies: {} };
  }
};

const saveState = (
  stateDir: string,
  state: { cursors: Record<string, number>; denies: Record<string, number> },
): void => {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(statePath(stateDir), `${JSON.stringify(state)}\n`);
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

export const incrementDenyCount = (ticket: string, stateDir: string = resolveHookStateDir()): number => {
  const state = loadState(stateDir);
  const next = (state.denies[ticket] ?? 0) + 1;
  state.denies[ticket] = next;
  saveState(stateDir, state);
  return next;
};
