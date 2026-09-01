import mcpApps from 'agent-bundle/mcp-apps';

import { createConductorServer, selectDashboardResource } from '../server.js';

/**
 * Conventional stdio entry: `agent-bundle build` wraps the default-exported
 * factory in the framework lifecycle shell. The compiled MCP-app registry is
 * injected only in the artifact bundle.
 */
export default () => createConductorServer(selectDashboardResource(mcpApps));
