import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import { reportConductorStatus } from '../status.js';

export const createConductorServer = (): McpServer => {
  const server = new McpServer({ name: 'cargo-conductor', version: '0.1.0' });

  server.registerTool('conductor_status', {
    description: 'Show the cargo-conductor daemon queue and in-flight cargo work.',
    inputSchema: z.object({}),
  }, async () => {
    const status = reportConductorStatus();
    return {
      content: [{ text: status.summary, type: 'text' }],
      structuredContent: { ...status },
    };
  });

  return server;
};

/**
 * Default-exported server factory at the conventional `src/mcp/conductor.ts`
 * entry: `agent-bundle build` wraps it in the framework stdio lifecycle shell.
 */
export default createConductorServer;
