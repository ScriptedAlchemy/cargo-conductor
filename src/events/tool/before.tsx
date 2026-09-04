import { Agent } from '@agent-bundle/runtime';
import type { AgentEventRouteConfig, AgentEventRouteProps } from 'agent-bundle';
import React from 'react';

import { handleBeforeShell } from '../../hooks/before-shell.js';
import { decisionValue, shellEventFrom } from '../../lib/event-support.js';

export const config = {
  // The portable playground target defines no hooks; events ship with the plugin hosts.
  targets: ['claude', 'codex', 'cursor'],
  fallback: 'standalone',
  runtime: 'shared',
  timeoutMs: 10_000,
  tools: ['shell'],
} satisfies AgentEventRouteConfig;

export default async function BeforeShellTool({ canonical }: AgentEventRouteProps<'tool/before'>) {
  const { host, nativeEvent } = canonical.provenance;
  const result = await handleBeforeShell(shellEventFrom(canonical.payload), { nativeEvent, target: host });
  return (
    <Agent.Result value={decisionValue(result)}>
      {result.additionalContext === undefined ? null : <Agent.Context>{result.additionalContext}</Agent.Context>}
    </Agent.Result>
  );
}
