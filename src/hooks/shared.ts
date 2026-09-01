import type { HookRecord } from './record.js';

export interface HookContext {
  readonly nativeEvent?: string;
  readonly nativeInput?: Readonly<Record<string, unknown>>;
  readonly target?: string;
}

export interface HookServices {
  readonly conductorArgv?: readonly string[];
  readonly hasActiveBuilds?: () => boolean | null | Promise<boolean | null>;
  readonly nowMs?: () => number;
  readonly record?: (event: HookRecord) => void | Promise<void>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const extractShellCommand = (toolInput: unknown): string | undefined => {
  if (!isRecord(toolInput) || typeof toolInput.command !== 'string') {
    return undefined;
  }
  return toolInput.command;
};

export const resolveHookHost = (
  context: HookContext | undefined,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string => {
  const nativeEvent = context?.nativeEvent;
  if (nativeEvent === 'preToolUse' || nativeEvent === 'postToolUse') {
    return 'cursor';
  }
  const target = context?.target;
  if (target === 'claude' || target === 'codex' || target === 'cursor') {
    return target;
  }
  const declared = env.AGENT_BUNDLE_HOOK_HOST;
  if (declared === 'claude' || declared === 'codex' || declared === 'cursor') {
    return declared;
  }
  return target ?? 'plugin';
};
