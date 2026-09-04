import { Agent } from '@agent-bundle/runtime';
import type { AgentEventRouteConfig, AgentEventRouteProps } from 'agent-bundle';
import React from 'react';

import { handleStopHold } from '../hooks/stop-hold.js';
import { decisionValue } from '../lib/event-support.js';

// Standalone: stop-hold may block for its bounded wait and must not occupy
// the shared MCP runtime. Budget mirrors the former 900 s stop hook.
export const config = {
  // The portable playground target defines no hooks; events ship with the plugin hosts.
  targets: ['claude', 'codex', 'cursor'],
  runtime: 'standalone',
  timeoutMs: 900_000,
} satisfies AgentEventRouteConfig;

export default async function StopHold({ canonical }: AgentEventRouteProps<'stop'>) {
  // `reentry` is the canonical reading of Claude/Codex `stop_hook_active` and
  // Cursor `loop_count > 0` (agent-bundle#466).
  const result = await handleStopHold({
    sessionId: canonical.payload.sessionId?.value,
    stopHookActive: canonical.payload.reentry?.value,
  });
  // Stop routes ignore Context nodes; the deny reason is the only channel.
  return <Agent.Result value={decisionValue(result)} />;
}
