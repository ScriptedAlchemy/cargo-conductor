import mcpApps from 'agent-bundle/mcp-apps';

import { createHaulerServer, selectDashboardResource } from '../server.js';

export default () => createHaulerServer(selectDashboardResource(mcpApps));
