import mcpApps from 'agent-bundle/mcp-apps';

import { createConductorServer, selectDashboardResource } from '../server.js';

export default () => createConductorServer(selectDashboardResource(mcpApps));
