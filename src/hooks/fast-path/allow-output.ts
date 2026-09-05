import type { JsonObject } from 'agent-bundle';

/** The hosts whose hook documents the packs register (`HookHandlerContext['target']`). */
export type HookHost = 'claude' | 'codex' | 'cursor';

/**
 * The rewritten `tool_input` as the config-declared hook contract types it.
 * `before-shell.ts` builds it from the host's own JSON `tool_input` with
 * `command` replaced by a string, so it is JSON at run time; like
 * `documentValue` in `src/lib/json.ts` this bridges only the static view
 * (`Record<string, unknown>` versus the contract's `JsonObject`).
 */
export const jsonObjectOf = (value: Readonly<Record<string, unknown>>): JsonObject => value as JsonObject;

/**
 * The host-native output for an `allow` decision on `tool/before`: what
 * agent-bundle's event-route projector emits for `{ outcome: 'allow',
 * updatedInput }` (`projectEventDocument`, `tool/before` branch — Cursor's
 * `permission` / `updated_input`, Claude's and Codex's `hookSpecificOutput`
 * with `permissionDecision: 'allow'`).
 *
 * The config-declared hook contract (`HookResult<'beforeTool'>`,
 * agent-bundle#488) admits `continue` and `deny` but not `allow`, and a
 * `continue` with `updatedInput` would hand the rewritten command back to the
 * host's own permission flow — a prompt the hauler has never introduced (see
 * `BeforeShellResult`). Until the contract carries `allow`, the fast entry
 * writes this one shape itself and returns nothing to the wrapper. Every
 * other result (`continue`, `deny`, `additionalContext`) goes through the
 * framework's projection unchanged.
 */
export const allowOutput = (
  host: HookHost,
  nativeEvent: string,
  updatedInput: JsonObject | undefined,
): Readonly<Record<string, unknown>> => {
  switch (host) {
    case 'cursor':
      return { permission: 'allow', ...(updatedInput === undefined ? {} : { updated_input: updatedInput }) };
    case 'claude':
    case 'codex':
      return {
        hookSpecificOutput: {
          hookEventName: nativeEvent,
          permissionDecision: 'allow',
          ...(updatedInput === undefined ? {} : { updatedInput }),
        },
      };
    default: {
      const exhaustive: never = host;
      return exhaustive;
    }
  }
};
