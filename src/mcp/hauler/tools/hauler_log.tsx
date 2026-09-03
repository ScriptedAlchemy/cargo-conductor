import { Agent, agent } from '@agent-bundle/runtime';
import type { ToolConfig, ToolRouteProps } from 'agent-bundle';
import React from 'react';

import { RequestTable } from '../../../components/request-table.js';
import { loadLogResult } from '../../../lib/inspect.js';
import { limitInputSchema, logResultSchema } from '../../../lib/protocol-schemas.js';
import { requestDaemonConfig } from '../../../lib/request-config.js';
import { documentValue } from '../../../lib/json.js';

export const config = {
  annotations: { readOnlyHint: true },
  description: 'Show recent cargo-hauler requests from the durable ledger.',
  title: 'Hauler log',
} satisfies ToolConfig;

export const inputSchema = limitInputSchema;
export const resultSchema = logResultSchema;

export default async function HaulerLog({ input, signal }: ToolRouteProps<typeof inputSchema>) {
  const context = await agent();
  const log = await loadLogResult(input, { config: requestDaemonConfig(context), signal });
  return (
    <Agent.Result value={documentValue(log)}>
      <Agent.Text>{log.summary}</Agent.Text>
      <RequestTable nowMs={Date.now()} records={log.requests} />
    </Agent.Result>
  );
}
