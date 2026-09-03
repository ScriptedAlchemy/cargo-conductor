import { Agent } from '@agent-bundle/runtime';
import type { AgentEventRouteConfig, AgentEventRouteProps } from 'agent-bundle';
import React from 'react';

import { handleBeforeShell } from '../../hooks/before-shell.js';
import { beforeShellEventFrom, decisionValue, hookContextFrom } from '../../lib/event-support.js';

export const config = {
  // The portable playground target defines no hooks; events ship with the plugin hosts.
  targets: ['plugin'],
  fallback: 'standalone',
  runtime: 'shared',
  timeoutMs: 10_000,
  tools: ['shell'],
} satisfies AgentEventRouteConfig;

export default async function BeforeShellTool({ canonical, native }: AgentEventRouteProps) {
  const result = await handleBeforeShell(beforeShellEventFrom(native), hookContextFrom(canonical, native));
  return (
    <Agent.Result value={decisionValue(result)}>
      {result.additionalContext === undefined ? null : <Agent.Context>{result.additionalContext}</Agent.Context>}
    </Agent.Result>
  );
}
