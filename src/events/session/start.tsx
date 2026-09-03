import { Agent, agent } from '@agent-bundle/runtime';
import type { AgentEventRouteConfig, AgentEventRouteProps } from 'agent-bundle';
import React from 'react';

import { daemonBadgeModel } from '../../components/view-models.js';
import { probeDaemonHealth } from '../../lib/daemon-health.js';
import { decisionValue } from '../../lib/event-support.js';
import { requestDaemonConfig } from '../../lib/request-config.js';

/**
 * Session start: tell the new session what the hauler daemon looks like right
 * now, so the first cargo decision is made with the fleet state in view
 * instead of a `ps` probe. Standalone and short: a session must never wait on
 * the shared MCP runtime to begin, and a saturated daemon is reported as such
 * within the probe budget rather than delaying the session.
 */
export const config = {
  // The portable target defines no hooks; the three plugin hosts do.
  targets: ['claude', 'codex', 'cursor'],
  runtime: 'standalone',
  timeoutMs: 5_000,
} satisfies AgentEventRouteConfig;

const notice = (model: ReturnType<typeof daemonBadgeModel>): string => {
  switch (model.state) {
    case 'running':
      return `cargo-hauler ${model.headline}; ${model.detail ?? ''}. Before running cargo, check \`hauler status --session <id>\` (or the hauler_status tool with its session field) and attach to in-flight work instead of starting a duplicate; never kill in-flight cargo.`;
    case 'stopped':
      return `cargo-hauler ${model.headline} (${model.detail ?? 'no detail'}). It starts on demand with the first brokered cargo command; the hooks route cargo through it automatically.`;
    case 'unresponsive':
      return `cargo-hauler ${model.headline}: ${model.detail ?? ''}. Treat the machine as saturated — prefer \`hauler status\` (or the hauler_status tool) over new builds until it answers.`;
    case 'unreachable':
      return `cargo-hauler ${model.headline}: ${model.detail ?? ''}. Cargo still runs (the hooks fail open), but nothing is brokered until the socket can be opened.`;
    case 'unprobed':
      return 'cargo-hauler daemon state was not probed for this session.';
    default: {
      const exhaustive: never = model.state;
      return exhaustive;
    }
  }
};

export default async function SessionStart({ signal }: AgentEventRouteProps) {
  const context = await agent();
  const health = await probeDaemonHealth(requestDaemonConfig(context), { signal });
  return (
    <Agent.Result value={decisionValue({ outcome: 'continue' })}>
      <Agent.Context>{notice(daemonBadgeModel(health, Date.now()))}</Agent.Context>
    </Agent.Result>
  );
}
