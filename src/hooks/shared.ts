import { isRecord } from '../lib/guards.js';
import { countWord } from '../lib/text.js';

import type { HookRecord } from './record.js';
import type { DeniedAttempt, FinishedTicket } from './rpc.js';

export { isRecord, countWord };

export interface HookContext {
  readonly nativeEvent?: string;
  readonly nativeInput?: Readonly<Record<string, unknown>>;
  readonly target?: string;
}

export interface HookServices {
  readonly completedSince?: (session: string, sinceMs: number) => Promise<readonly FinishedTicket[]>;
  readonly conductorArgv?: readonly string[];
  readonly hasActiveBuilds?: () => boolean | null | Promise<boolean | null>;
  readonly nowMs?: () => number;
  readonly readCursor?: (session: string) => number;
  readonly record?: (event: HookRecord) => void | Promise<void>;
  readonly recordAttempt?: (attempt: DeniedAttempt) => void | Promise<void>;
  readonly writeCursor?: (session: string, atMs: number) => void;
}

const diagnosticCounts = (ticket: FinishedTicket): string | null =>
  ticket.errorCount === null || ticket.warningCount === null
    ? null
    : `${countWord(ticket.errorCount, 'error')}, ${countWord(ticket.warningCount, 'warning')}`;

export const formatFinishedTicket = (ticket: FinishedTicket): string => {
  const counts = diagnosticCounts(ticket);
  switch (ticket.status) {
    case 'done':
      return `ticket ${ticket.ticket} finished: success${counts === null ? '' : `, ${counts}`} — call conductor_result ${ticket.ticket}`;
    case 'failed': {
      const detail =
        ticket.error === null || ticket.error.length === 0 ? '' : ` (${ticket.error})`;
      return `ticket ${ticket.ticket} finished: failed${counts === null ? '' : `, ${counts}`}${detail} — call conductor_result ${ticket.ticket}`;
    }
    case 'killed':
      return `ticket ${ticket.ticket} finished: killed${counts === null ? '' : `, ${counts}`} — call conductor_result ${ticket.ticket}`;
    default: {
      const exhaustive: never = ticket.status;
      return exhaustive;
    }
  }
};

export const extractShellCommand = (toolInput: unknown): string | undefined => {
  if (!isRecord(toolInput) || typeof toolInput.command !== 'string') {
    return undefined;
  }
  return toolInput.command;
};

export const resolveHookHost = (
  context: HookContext | undefined,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string => {
  const nativeEvent = context?.nativeEvent;
  if (nativeEvent === 'preToolUse' || nativeEvent === 'postToolUse') {
    return 'cursor';
  }
  const target = context?.target;
  if (target === 'claude' || target === 'codex' || target === 'cursor') {
    return target;
  }
  const declared = env.AGENT_BUNDLE_HOOK_HOST;
  if (declared === 'claude' || declared === 'codex' || declared === 'cursor') {
    return declared;
  }
  return target ?? 'plugin';
};
