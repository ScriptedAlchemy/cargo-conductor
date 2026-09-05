import { isRecord } from './guards.js';

/**
 * `tool_input.command` as the host sent it; `undefined` when the tool input
 * is not a shell call (Read, Edit, an MCP tool, Codex's non-object input).
 * Dependency-free on purpose: the hook fast path reads it before anything
 * heavier loads.
 */
export const extractShellCommand = (toolInput: unknown): string | undefined => {
  if (!isRecord(toolInput) || typeof toolInput.command !== 'string') {
    return undefined;
  }
  return toolInput.command;
};
