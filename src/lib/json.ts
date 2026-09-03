import type { JsonValue } from '@agent-bundle/runtime';

/**
 * `Agent.Result` takes a `JsonValue`, whose index signature rejects
 * interfaces with optional members (their type includes `undefined`). Route
 * results are assembled with conditional spreads, so no member is ever
 * `undefined` at run time and the runtime's JSON snapshot accepts them; this
 * bridges only the static view.
 */
export const documentValue = <T extends object>(result: T): JsonValue =>
  result as unknown as JsonValue;
