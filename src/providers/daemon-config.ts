import type { AgentProviderFactory } from 'agent-bundle';

import { resolveDaemonConfig } from '../daemon/config.js';

/**
 * Mounted at `(await agent()).providers.daemonConfig` for every generated
 * MCP, event, and rendered CLI request. Resolving once per request means a
 * route reads state-dir/socket identity from one place, and route-unit tests
 * can inject an isolated config through the harness `context.providers` seam.
 */
const daemonConfig: AgentProviderFactory = () => resolveDaemonConfig();

export default daemonConfig;
