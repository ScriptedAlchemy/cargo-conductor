import { readCursor, writeCursor } from './hook-state.js';
import { appendHookRecord } from './record.js';
import { listSessionCompleted } from './rpc.js';
import type { FinishedTicket } from './rpc.js';
import {
  extractShellCommand,
  formatFinishedTicket,
  isRecord,
  resolveHookHost,
  type HookContext,
  type HookServices,
} from './shared.js';

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

const extractExitCode = (toolResponse: unknown): number | undefined => {
  if (!isRecord(toolResponse)) {
    return undefined;
  }
  const value = toolResponse.exitCode ?? toolResponse.exit_code;
  return typeof value === 'number' ? value : undefined;
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
  if (finished.length === 0) {
    // The query is `finished_at_ms >= cursor`, so leaving the cursor where it
    // was returns the same (empty) set next time; skip the state-file write.
    return undefined;
  }
  write(session, nowMs);
  return finished.map(formatFinishedTicket).join('\n');
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
  // Only cargo/hauler activity belongs in the telemetry log; every other
  // shell command still flows through so completion notifications inject.
  if (command.includes('cargo') || command.includes('hauler')) {
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
  }
  const additionalContext = await notifyContext(event.sessionId, services);
  return additionalContext === undefined
    ? { outcome: 'continue' }
    : { additionalContext, outcome: 'continue' };
};

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
