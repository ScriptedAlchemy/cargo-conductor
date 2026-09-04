import { prepareShellCommand } from './inspect.js';
import { resolveHaulerArgv } from './paths.js';
import { probeActiveBuilds, type DaemonProbe } from './probe.js';
import { appendHookRecord } from './record.js';
import { recordDeniedAttempt } from './rpc.js';
import {
  extractShellCommand,
  isRecord,
  resolveHookHost,
  type HookContext,
  type HookServices,
} from './shared.js';

export type { HookContext, HookServices };

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

const denyCleanReason =
  'cargo clean is blocked while cargo-hauler has in-flight builds; wait for them to finish or run hauler status';

// Telemetry only: whitespace splitting intentionally does not preserve quoted arguments.
const attemptArgv = (command: string): readonly string[] => command.trim().split(/\s+/u);

interface DenyCleanInput {
  readonly command: string;
  readonly cwd: string | undefined;
  readonly host: string;
  readonly nowMs: () => number;
  readonly record: NonNullable<HookServices['record']>;
  readonly session: string;
  readonly submitAttempt: NonNullable<HookServices['recordAttempt']>;
  readonly toolName: string | undefined;
}

const denyClean = async (input: DenyCleanInput): Promise<BeforeShellResult> => {
  await input.record({
    atMs: input.nowMs(),
    command: input.command,
    host: input.host,
    outcome: 'deny',
    phase: 'beforeTool',
    reason: denyCleanReason,
    session: input.session,
    ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
    ...(input.toolName === undefined ? {} : { toolName: input.toolName }),
  });
  try {
    void Promise.resolve(
      input.submitAttempt({
        argv: attemptArgv(input.command),
        cwd: input.cwd ?? process.cwd(),
        host: input.host,
        reason: denyCleanReason,
        session: input.session,
      }),
    ).catch(() => undefined);
  } catch {
    // Attempt telemetry is strictly fail-open at the hook boundary.
  }
  return { outcome: 'deny', reason: denyCleanReason };
};

const decideBeforeShell = async (
  event: BeforeShellEvent,
  context: HookContext,
  services: HookServices,
): Promise<BeforeShellResult> => {
  const command = extractShellCommand(event.toolInput);
  if (command === undefined) {
    return continueResult();
  }

  const prepared = prepareShellCommand(command);
  const inspection = prepared.inspection;
  // `alreadyWrapped` alone is not a short-circuit: `hauler exec -- cargo build
  // && cargo test` still has an unbrokered half.
  if (!inspection.hasCargo) {
    return continueResult();
  }

  const host = resolveHookHost(context);
  const session = event.sessionId ?? 'unknown';
  const cwd = event.cwd;
  const nowMs = services.nowMs ?? Date.now;
  const record = services.record ?? appendHookRecord;

  if (inspection.destructive) {
    const probe = services.probeDaemon ?? probeActiveBuilds;
    let verdict: DaemonProbe;
    try {
      verdict = await probe();
    } catch {
      verdict = 'absent';
    }
    switch (verdict) {
      case 'idle':
      case 'busy':
        // Idle: broker it like any other cargo command. Busy: the daemon is
        // alive but saturated, which is when a raw clean would race its
        // lanes; the rewrite lets the lane serialize the clean instead.
        break;
      case 'absent':
        // No daemon: nothing to race, and brokering would only auto-start one
        // for a clean.
        return continueResult();
      case 'active':
        return denyClean({
          command,
          cwd,
          host,
          nowMs,
          record,
          session,
          submitAttempt: services.recordAttempt ?? recordDeniedAttempt,
          toolName: event.toolName,
        });
      default: {
        const exhaustive: never = verdict;
        return exhaustive;
      }
    }
  }

  const rewritten = prepared.rewrite({
    haulerArgv: services.haulerArgv ?? resolveHaulerArgv(),
    host,
    session,
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
