import { Agent, agent } from '@agent-bundle/runtime';
import type { ToolConfig, ToolRouteProps } from 'agent-bundle';
import React from 'react';

import { TicketCard, TicketGuidance } from '../../../components/ticket-card.js';
import { resultFetchResultSchema, ticketInputSchema } from '../../../lib/protocol-schemas.js';
import { requestDaemonConfig } from '../../../lib/request-config.js';
import { fetchTicketResult } from '../../../lib/tickets.js';
import { documentValue } from '../../../lib/json.js';

export const config = {
  annotations: { readOnlyHint: true },
  description:
    'Fetch one cargo-hauler ticket. Running tickets include a live output-tail snapshot; terminal tickets include the durable ledger result.',
  title: 'Hauler ticket result',
} satisfies ToolConfig;

export const inputSchema = ticketInputSchema;
export const resultSchema = resultFetchResultSchema;

export default async function HaulerResult({ input, signal }: ToolRouteProps<typeof inputSchema>) {
  const context = await agent();
  const result = await fetchTicketResult(input, { config: requestDaemonConfig(context), signal });
  return (
    <Agent.Result value={documentValue(result)}>
      <Agent.Text>{result.summary}</Agent.Text>
      {result.request === null ? (
        <Agent.Context>
          {`${input.ticket} is not known to the daemon. Tickets look like cc-123; check hauler_log for recent ids.`}
        </Agent.Context>
      ) : (
        <>
          <TicketCard nowMs={Date.now()} record={result.request} />
          <TicketGuidance record={result.request} />
        </>
      )}
    </Agent.Result>
  );
}
