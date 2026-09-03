import { Agent } from '@agent-bundle/runtime';
import type { AgentEventRouteConfig, AgentEventRouteProps } from 'agent-bundle';
import React from 'react';

import { handleAfterShell } from '../../hooks/after-shell.js';
import { afterShellEventFrom, decisionValue, hookContextFrom } from '../../lib/event-support.js';

export const config = {
  // The portable playground target defines no hooks; events ship with the plugin hosts.
  targets: ['claude', 'codex', 'cursor'],
  fallback: 'standalone',
  runtime: 'shared',
  timeoutMs: 10_000,
  tools: ['shell'],
} satisfies AgentEventRouteConfig;

export default async function AfterShellTool({ canonical, native }: AgentEventRouteProps) {
  const result = await handleAfterShell(afterShellEventFrom(native), hookContextFrom(canonical, native));
  return (
    <Agent.Result value={decisionValue(result)}>
      {result.additionalContext === undefined ? null : <Agent.Context>{result.additionalContext}</Agent.Context>}
    </Agent.Result>
  );
}
