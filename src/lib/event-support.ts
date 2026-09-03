import type { JsonValue } from '@agent-bundle/runtime';
import type { AgentEventCanonicalIdentity, AgentEventNativePayload } from 'agent-bundle';

import type { AfterShellEvent } from '../hooks/after-shell.js';
import type { BeforeShellEvent } from '../hooks/before-shell.js';
import type { HookContext } from '../hooks/shared.js';
import type { StopHoldEvent } from '../hooks/stop-hold.js';

import { isRecord } from './guards.js';
import { documentValue } from './json.js';

/**
 * Bridges host-native event envelopes (Claude/Codex `snake_case`, Cursor
 * `conversation_id` + string `tool_output`) onto the canonical event shapes
 * the hook libraries in `src/hooks/*` already accept.
 */

const nativeString = (native: AgentEventNativePayload, ...keys: readonly string[]): string | undefined => {
  for (const key of keys) {
    const value = native[key];
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  return undefined;
};

const nativeRecord = (
  native: AgentEventNativePayload,
  key: string,
): Readonly<Record<string, unknown>> | undefined => {
  const value = native[key];
  return isRecord(value) ? value : undefined;
};

const parseJsonRecord = (text: string): Readonly<Record<string, unknown>> | undefined => {
  try {
    const parsed = JSON.parse(text) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
};

export const hookContextFrom = (
  canonical: AgentEventCanonicalIdentity,
  native: AgentEventNativePayload,
): HookContext => ({
  nativeEvent: canonical.provenance.nativeEvent,
  nativeInput: native,
  target: canonical.provenance.host,
});

export const beforeShellEventFrom = (native: AgentEventNativePayload): BeforeShellEvent => {
  const cwd = nativeString(native, 'cwd');
  const sessionId = nativeString(native, 'session_id', 'conversation_id');
  const toolInput = nativeRecord(native, 'tool_input');
  const toolName = nativeString(native, 'tool_name');
  const toolUseId = nativeString(native, 'tool_use_id');
  return {
    ...(cwd === undefined ? {} : { cwd }),
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(toolInput === undefined ? {} : { toolInput }),
    ...(toolName === undefined ? {} : { toolName }),
    ...(toolUseId === undefined ? {} : { toolUseId }),
  };
};

/** Claude/Codex send `tool_response` as an object; Cursor sends `tool_output` as a string. */
const toolResponseFrom = (native: AgentEventNativePayload): Readonly<Record<string, unknown>> | undefined => {
  const response = nativeRecord(native, 'tool_response');
  if (response !== undefined) {
    return response;
  }
  const output = native.tool_output;
  return typeof output === 'string' ? parseJsonRecord(output) : undefined;
};

export const afterShellEventFrom = (native: AgentEventNativePayload): AfterShellEvent => {
  const toolResponse = toolResponseFrom(native);
  return {
    ...beforeShellEventFrom(native),
    ...(toolResponse === undefined ? {} : { toolResponse }),
  };
};

/** Cursor reports re-entry as `loop_count`; Claude/Codex as `stop_hook_active`. */
const stopHookActiveFrom = (native: AgentEventNativePayload): boolean | undefined => {
  if (typeof native.stop_hook_active === 'boolean') {
    return native.stop_hook_active;
  }
  if (typeof native.loop_count === 'number') {
    return native.loop_count > 0;
  }
  return undefined;
};

export const stopHoldEventFrom = (native: AgentEventNativePayload): StopHoldEvent => {
  const sessionId = nativeString(native, 'session_id', 'conversation_id');
  const stopHookActive = stopHookActiveFrom(native);
  return {
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(stopHookActive === undefined ? {} : { stopHookActive }),
  };
};

export interface EventDecision {
  readonly outcome: 'continue' | 'deny';
  readonly reason?: string;
  readonly updatedInput?: Readonly<Record<string, unknown>>;
}

/**
 * The strict route-result value: only `outcome`, `reason`, `updatedInput`.
 * Additional context travels as `<Agent.Context>` children, never here.
 */
export const decisionValue = (decision: EventDecision): JsonValue =>
  documentValue({
    outcome: decision.outcome,
    ...(decision.reason === undefined || decision.reason.length === 0 ? {} : { reason: decision.reason }),
    ...(decision.updatedInput === undefined ? {} : { updatedInput: decision.updatedInput }),
  });
