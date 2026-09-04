import type { JsonValue } from '@agent-bundle/runtime';
import type { AgentEventPayload } from 'agent-bundle';

import type { AfterShellEvent } from '../hooks/after-shell.js';

import { documentValue } from './json.js';

/**
 * The hook libraries' shell event read from the framework's canonical payload
 * (agent-bundle#466): one cross-host reading of the envelope, each field absent
 * when the host did not send it. A `tool/before` payload is the same reading
 * without `toolResponse`, so `handleBeforeShell` takes the result as is.
 */
export const shellEventFrom = (payload: AgentEventPayload<'tool/before' | 'tool/after'>): AfterShellEvent => ({
  cwd: payload.cwd?.value,
  sessionId: payload.sessionId?.value,
  toolInput: payload.toolInput?.value,
  toolName: payload.toolName?.value,
  toolResponse: payload.toolResponse?.value,
  toolUseId: payload.toolUseId?.value,
});

/**
 * `continue` is the no-decision answer (the host's own flow applies), `allow`
 * is the explicit `tool/before` approval for a hauler-governed rewrite, and
 * `deny` blocks. No route ever returns `ask`: the hauler adds no prompts.
 */
export interface EventDecision {
  readonly outcome: 'continue' | 'allow' | 'deny';
  readonly reason?: string;
  readonly updatedInput?: Readonly<Record<string, unknown>>;
}

/**
 * The strict route-result value: only `outcome`, `reason`, `updatedInput`.
 * Additional context travels as `<Agent.Context>` children, never here. A
 * `continue` result carries no decision, so it has no channel for `reason`
 * (agent-bundle rejects the pair); the reason is dropped there.
 */
export const decisionValue = (decision: EventDecision): JsonValue =>
  documentValue({
    outcome: decision.outcome,
    ...(decision.outcome === 'continue' || decision.reason === undefined || decision.reason.length === 0
      ? {}
      : { reason: decision.reason }),
    ...(decision.updatedInput === undefined ? {} : { updatedInput: decision.updatedInput }),
  });
