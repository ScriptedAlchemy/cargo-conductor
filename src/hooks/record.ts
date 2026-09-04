import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { resolveHookStateDir } from './paths.js';

export interface HookRecord {
  readonly atMs: number;
  readonly command: string;
  readonly cwd?: string;
  readonly exitCode?: number | null;
  readonly host: string;
  readonly outcome: 'continue' | 'allow' | 'deny';
  readonly phase: 'beforeTool' | 'afterTool';
  readonly reason?: string;
  readonly rewritten?: string;
  readonly session?: string;
  readonly toolName?: string;
}

export const hookEventsFileName = 'hook-events.jsonl';

export const appendHookRecord = (
  record: HookRecord,
  stateDir: string = resolveHookStateDir(),
): void => {
  mkdirSync(stateDir, { recursive: true });
  appendFileSync(join(stateDir, hookEventsFileName), `${JSON.stringify(record)}\n`);
};
