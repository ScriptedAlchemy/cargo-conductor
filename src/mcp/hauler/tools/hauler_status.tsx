import { agent } from '@agent-bundle/runtime';
import type { ToolConfig, ToolRouteProps } from 'agent-bundle';
import React from 'react';

import { StatusDocument } from '../../../components/documents.js';
import { mcpSurface } from '../../../components/surface.js';
import { APP_RESOURCE_URI } from '../../../constants.js';
import { loadStatusResult } from '../../../lib/inspect.js';
import { statusInputSchema, statusResultSchema } from '../../../lib/protocol-schemas.js';
import { requestDaemonConfig } from '../../../lib/request-config.js';
import { hasStatusFilters } from '../../../lib/status-filter.js';

export const config = {
  // The compiler resolves the imported const statically (one relative hop to
  // a string-literal `export const`), so the App route and this tool share
  // one source for the dashboard URI instead of hand-synced literals.
  _meta: { ui: { resourceUri: APP_RESOURCE_URI } },
  annotations: { readOnlyHint: true },
  description:
    'Show cargo-hauler queue and in-flight work. Filter by cwd, session, laneKey, tickets, statuses, or commandContains instead of piping CLI JSON through jq. Rows are bounded summaries: no output tail, only a short outputPreview (last 8 lines) on running rows; read one ticket with hauler_result for its whole live tail.',
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
