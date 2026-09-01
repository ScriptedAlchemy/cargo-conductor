import { inspectShellCommand, rewriteShellCommand } from './inspect.js';
import { resolveConductorArgv } from './paths.js';
import { probeActiveBuilds } from './probe.js';
import { appendHookRecord, type HookRecord } from './record.js';
import {
  extractShellCommand,
  resolveHookHost,
  type HookContext,
  type HookServices,
} from './shared.js';

export type { HookContext, HookServices };
export { extractShellCommand, resolveHookHost };

export interface BeforeShellEvent {
  readonly cwd?: string;
  readonly sessionId?: string;
  readonly toolInput?: Readonly<Record<string, unknown>>;
  readonly toolName?: string;
  readonly toolUseId?: string;
}

export interface BeforeShellResult {
  readonly additionalContext?: string;
  readonly outcome: 'continue' | 'deny';
  readonly reason?: string;
  readonly updatedInput?: Readonly<Record<string, unknown>>;
}

const continueResult = (): BeforeShellResult => ({ outcome: 'continue' });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const denyCleanReason =
  'cargo clean is blocked while cargo-conductor has in-flight builds; wait for them to finish or run conductor status';

const decideBeforeShell = async (
  event: BeforeShellEvent,
  context: HookContext,
  services: HookServices,
): Promise<BeforeShellResult> => {
  const command = extractShellCommand(event.toolInput);
  if (command === undefined) {
    return continueResult();
  }

  const inspection = inspectShellCommand(command);
  if (inspection.alreadyWrapped || !inspection.hasCargo) {
    return continueResult();
  }

  const host = resolveHookHost(context);
  const session = event.sessionId ?? 'unknown';
  const cwd = event.cwd;
  const nowMs = services.nowMs ?? Date.now;
  const record = services.record ?? appendHookRecord;

  if (inspection.destructive) {
    const probe = services.hasActiveBuilds ?? probeActiveBuilds;
    let active: boolean | null;
    try {
      active = await probe();
    } catch {
      active = null;
    }
    if (active === true) {
      const denied: HookRecord = {
        atMs: nowMs(),
        command,
        host,
        outcome: 'deny',
        phase: 'beforeTool',
        reason: denyCleanReason,
        session,
        ...(cwd === undefined ? {} : { cwd }),
        ...(event.toolName === undefined ? {} : { toolName: event.toolName }),
      };
      await record(denied);
      return { outcome: 'deny', reason: denyCleanReason };
    }
    if (active === null) {
      return continueResult();
    }
  }

  const rewritten = rewriteShellCommand(command, {
    conductorArgv: services.conductorArgv ?? resolveConductorArgv(),
    host,
    session,
    ...(cwd === undefined ? {} : { cwd }),
  });
  if (rewritten === command) {
    return continueResult();
  }

  const toolInput = isRecord(event.toolInput) ? { ...event.toolInput, command: rewritten } : { command: rewritten };
  await record({
    atMs: nowMs(),
    command,
    host,
    outcome: 'continue',
    phase: 'beforeTool',
    rewritten,
    session,
    ...(cwd === undefined ? {} : { cwd }),
    ...(event.toolName === undefined ? {} : { toolName: event.toolName }),
  });
  return { outcome: 'continue', updatedInput: toolInput };
};

/**
 * Rewrite cargo shell calls to `conductor exec`. Fail-open on parse errors,
 * missing conductor identity, or a down daemon (deny policy only). A deny
 * never includes updatedInput.
 */
export const handleBeforeShell = async (
  event: BeforeShellEvent,
  context: HookContext = {},
  services: HookServices = {},
): Promise<BeforeShellResult> => {
  try {
    return await decideBeforeShell(event, context, services);
  } catch {
    return continueResult();
  }
};

export default handleBeforeShell;
