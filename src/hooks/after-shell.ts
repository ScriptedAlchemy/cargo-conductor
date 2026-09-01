import { appendHookRecord } from './record.js';
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
  return { outcome: 'continue' };
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
