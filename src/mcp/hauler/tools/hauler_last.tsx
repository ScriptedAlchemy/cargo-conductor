import { Agent, agent } from '@agent-bundle/runtime';
import type { ToolConfig, ToolRouteProps } from 'agent-bundle';
import React from 'react';

import { TicketCard, TicketGuidance } from '../../../components/ticket-card.js';
import { loadLastResult } from '../../../lib/inspect.js';
import { lastResultSchema, limitInputSchema } from '../../../lib/protocol-schemas.js';
import { requestDaemonConfig } from '../../../lib/request-config.js';
import { documentValue } from '../../../lib/json.js';

export const config = {
  annotations: { readOnlyHint: true },
  description: 'Show the most recent cargo-hauler request.',
  title: 'Hauler last request',
} satisfies ToolConfig;

export const inputSchema = limitInputSchema;
export const resultSchema = lastResultSchema;

export default async function HaulerLast({ signal }: ToolRouteProps<typeof inputSchema>) {
  const context = await agent();
  const last = await loadLastResult({ config: requestDaemonConfig(context), signal });
  return (
    <Agent.Result value={documentValue(last)}>
      <Agent.Text>{last.summary}</Agent.Text>
      {last.request === null ? null : (
        <>
          <TicketCard nowMs={Date.now()} record={last.request} />
          <TicketGuidance record={last.request} />
        </>
      )}
    </Agent.Result>
  );
}
