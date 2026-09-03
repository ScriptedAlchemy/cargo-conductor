import { agent } from '@agent-bundle/runtime';
import type { ToolConfig, ToolRouteProps } from 'agent-bundle';
import React from 'react';

import { StatusDocument } from '../../../components/documents.js';
import { mcpSurface } from '../../../components/surface.js';
import { loadStatusResult } from '../../../lib/inspect.js';
import { statusInputSchema, statusResultSchema } from '../../../lib/protocol-schemas.js';
import { requestDaemonConfig } from '../../../lib/request-config.js';
import { hasStatusFilters } from '../../../lib/status-filter.js';

export const config = {
  // The compiler reads this literal statically; it must equal
  // APP_RESOURCE_URI in src/constants.ts (pinned by tests).
  _meta: { ui: { resourceUri: 'ui://cargo-hauler/dashboard.html' } },
  annotations: { readOnlyHint: true },
  description:
    'Show cargo-hauler queue and in-flight work. Filter by cwd, session, laneKey, tickets, statuses, or commandContains instead of piping CLI JSON through jq.',
  title: 'Hauler status',
} satisfies ToolConfig;

export const inputSchema = statusInputSchema;
export const resultSchema = statusResultSchema;

export default async function HaulerStatus({ input, signal }: ToolRouteProps<typeof inputSchema>) {
  const context = await agent();
  const status = await loadStatusResult(input, { config: requestDaemonConfig(context), signal });
  return (
    <StatusDocument
      filtered={hasStatusFilters(input)}
      names={mcpSurface}
      nowMs={Date.now()}
      result={status}
    />
  );
}
