import { Agent, agent } from '@agent-bundle/runtime';
import type { ToolConfig, ToolRouteProps } from 'agent-bundle';
import React from 'react';

import { RequestTable } from '../../../components/request-table.js';
import { StatusOverview } from '../../../components/status-overview.js';
import { APP_RESOURCE_URI } from '../../../constants.js';
import { loadStatusResult } from '../../../lib/inspect.js';
import { statusInputSchema, statusResultSchema } from '../../../lib/protocol-schemas.js';
import { requestDaemonConfig } from '../../../lib/request-config.js';
import { hasStatusFilters } from '../../../lib/status-filter.js';

export const config = {
  _meta: { ui: { resourceUri: APP_RESOURCE_URI } },
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
  const nowMs = Date.now();
  const filtered = hasStatusFilters(input);
  return (
    <Agent.Result value={status}>
      <Agent.Text>{status.summary.split('\n', 1)[0] ?? status.summary}</Agent.Text>
      <StatusOverview nowMs={nowMs} status={status} />
      <RequestTable
        empty={filtered ? 'No active requests match these filters.' : 'Nothing queued or running.'}
        heading="In flight"
        nowMs={nowMs}
        records={status.active}
      />
      <RequestTable
        empty={filtered ? 'No recent requests match these filters.' : undefined}
        heading="Recent"
        nowMs={nowMs}
        records={status.recent}
      />
      {status.active.length > 0 ? (
        <Agent.Context>
          {`Do not start a duplicate cargo run for anything listed in flight: submit through hauler_request or run cargo normally and the hauler attaches you to the existing run. Wait with hauler_await <ticket>.`}
        </Agent.Context>
      ) : null}
    </Agent.Result>
  );
}
