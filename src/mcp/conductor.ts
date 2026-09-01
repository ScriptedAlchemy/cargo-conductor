import { createRscMcpServer } from '@agent-bundle/rsc-runtime/plugin';

import { conductorApplication } from '../application.js';

export const createConductorServer = () => createRscMcpServer(conductorApplication, 'conductor');

/**
 * Default-exported server factory at the conventional `src/mcp/conductor.ts`
 * entry: `agent-bundle build` wraps it in the framework stdio lifecycle shell.
 */
export default createConductorServer;
