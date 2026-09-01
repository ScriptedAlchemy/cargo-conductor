import { createRscMcpServer } from '@agent-bundle/rsc-runtime/plugin';
import type { McpServer } from '@modelcontextprotocol/server';
import type { McpAppResource } from 'agent-bundle/mcp-apps';

import { conductorApplication } from './application.js';
import { APP_RESOURCE_URI } from './constants.js';

export interface DashboardResource {
  readonly description: string;
  readonly html: string;
  readonly mimeType: string;
  readonly name: string;
  readonly resourceUri: string;
}

const dashboardName = 'cargo-conductor dashboard';
const dashboardDescription =
  'Live queue, in-flight work, history timeline, and contention stats for the cargo-conductor daemon.';

export const selectDashboardResource = (
  apps: readonly McpAppResource[],
): DashboardResource | undefined => {
  const app = apps.find((candidate) => candidate.resourceUri === APP_RESOURCE_URI);
  if (app === undefined) {
    return undefined;
  }
  return {
    description: dashboardDescription,
    html: app.html,
    mimeType: app.mimeType,
    name: dashboardName,
    resourceUri: app.resourceUri,
  };
};

export const createConductorServer = (widget?: DashboardResource): McpServer => {
  const server = createRscMcpServer(conductorApplication, 'conductor');
  if (widget !== undefined) {
    server.registerResource(
      widget.name,
      widget.resourceUri,
      {
        _meta: { ui: { prefersBorder: true } },
        description: widget.description,
        mimeType: widget.mimeType,
      },
      async (uri) => ({
        contents: [{ mimeType: widget.mimeType, text: widget.html, uri: uri.href }],
      }),
    );
  }
  return server;
};
