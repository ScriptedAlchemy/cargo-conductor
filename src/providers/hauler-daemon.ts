import type { AgentProviderContext } from 'agent-bundle';

import { resolveDaemonConfig, type DaemonConfigShape } from '../daemon/config.js';
import { probeDaemonHealth, type DaemonHealth } from '../lib/daemon-health.js';

/**
 * The daemon connection for one request, mounted at
 * `(await agent()).providers.haulerDaemon` (and `useAgent().providers.haulerDaemon`
 * in synchronous components) for every generated MCP tool, event route,
 * routed CLI command, and rendered script.
 *
 * `config` is where the daemon lives (state dir, socket, ledger) resolved
 * once from the environment; `health` is what one bounded probe proved about
 * it at request start. A probe never fabricates status: a missing socket or
 * refused connection is `stopped`, an accept that did not finish in time is
 * `unresponsive`, and event routes — which run on every shell command with a
 * ten-second budget — skip the probe and say so (`unprobed`), reaching for
 * `probeDaemonHealth` themselves only when the route needs it.
 */
export interface HaulerDaemonContext {
  readonly config: DaemonConfigShape;
  readonly health: DaemonHealth;
  readonly probedAt: string;
}

export default async function haulerDaemon(
  { invocation, signal }: AgentProviderContext,
): Promise<HaulerDaemonContext> {
  const config = resolveDaemonConfig();
  const health: DaemonHealth = invocation.kind === 'event'
    ? { reason: 'event-surface', state: 'unprobed' }
    : await probeDaemonHealth(config, { signal });
  return { config, health, probedAt: new Date().toISOString() };
}
