import { readCursor, writeCursor } from './hook-state.js';
import { appendHookRecord } from './record.js';
import { listSessionCompleted } from './rpc.js';
import type { FinishedTicket } from './rpc.js';
import { extractShellCommand, resolveHookHost, type HookContext, type HookServices } from './shared.js';

export interface AfterShellEvent {
  readonly cwd?: string;
  readonly sessionId?: string;
  readonly toolInput?: Readonly<Record<string, unknown>>;
  readonly toolName?: string;
  readonly toolResponse?: unknown;
  readonly toolUseId?: string;
}

export interface AfterShellResult {
  readonly additionalContext?: string;
  readonly outcome: 'continue';
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const extractExitCode = (toolResponse: unknown): number | undefined => {
  if (!isRecord(toolResponse)) {
    return undefined;
  }
  const value = toolResponse.exitCode ?? toolResponse.exit_code;
  return typeof value === 'number' ? value : undefined;
};

const formatFinished = (ticket: FinishedTicket): string => {
  switch (ticket.status) {
    case 'done':
      return `ticket ${ticket.ticket} finished: success, 0 errors — call conductor_result ${ticket.ticket}`;
    case 'failed':
      return `ticket ${ticket.ticket} finished: failed${ticket.error === null || ticket.error.length === 0 ? '' : `, ${ticket.error}`} — call conductor_result ${ticket.ticket}`;
    case 'killed':
      return `ticket ${ticket.ticket} finished: killed — call conductor_result ${ticket.ticket}`;
    default: {
      const exhaustive: never = ticket.status;
      return exhaustive;
    }
  }
};

const notifyContext = async (
  session: string | undefined,
  services: HookServices,
): Promise<string | undefined> => {
  if (session === undefined || session.length === 0) {
    return undefined;
  }
  const read = services.readCursor ?? readCursor;
  const write = services.writeCursor ?? writeCursor;
  const completedSince = services.completedSince ?? listSessionCompleted;
  const sinceMs = read(session);
  const nowMs = (services.nowMs ?? Date.now)();
  let finished: readonly FinishedTicket[];
  try {
    finished = await completedSince(session, sinceMs);
  } catch {
    return undefined;
  }
  write(session, nowMs);
  if (finished.length === 0) {
    return undefined;
  }
  return finished.map(formatFinished).join('\n');
};

const decideAfterShell = async (
  event: AfterShellEvent,
  context: HookContext,
  services: HookServices,
): Promise<AfterShellResult> => {
  const command = extractShellCommand(event.toolInput);
  if (command === undefined) {
    return { outcome: 'continue' };
  }
  const record = services.record ?? appendHookRecord;
  const exitCode = extractExitCode(event.toolResponse);
  await record({
    atMs: (services.nowMs ?? Date.now)(),
    command,
    host: resolveHookHost(context),
    outcome: 'continue',
    phase: 'afterTool',
    ...(event.cwd === undefined ? {} : { cwd: event.cwd }),
    ...(exitCode === undefined ? {} : { exitCode }),
    ...(event.sessionId === undefined ? {} : { session: event.sessionId }),
    ...(event.toolName === undefined ? {} : { toolName: event.toolName }),
  });
  const additionalContext = await notifyContext(event.sessionId, services);
  return additionalContext === undefined
    ? { outcome: 'continue' }
    : { additionalContext, outcome: 'continue' };
};

/** Ledger the completed shell tool. afterTool cannot deny or replace input. */
export const handleAfterShell = async (
  event: AfterShellEvent,
  context: HookContext = {},
  services: HookServices = {},
): Promise<AfterShellResult> => {
  try {
    return await decideAfterShell(event, context, services);
  } catch {
    return { outcome: 'continue' };
  }
};

export default handleAfterShell;
