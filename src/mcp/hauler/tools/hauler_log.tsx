import { agent } from '@agent-bundle/runtime';
import type { ToolConfig, ToolRouteProps } from 'agent-bundle';
import React from 'react';

import { LogStream } from '../../../components/streaming.js';
import { mcpSurface } from '../../../components/surface.js';
import { loadLogResult } from '../../../lib/inspect.js';
import { limitInputSchema, logResultSchema } from '../../../lib/protocol-schemas.js';
import { requestDaemonConfig } from '../../../lib/request-config.js';

export const config = {
  annotations: { readOnlyHint: true },
  description: 'List recent cargo-hauler requests from the ledger, newest first.',
  title: 'Hauler log',
} satisfies ToolConfig;

export const inputSchema = limitInputSchema;
export const resultSchema = logResultSchema;

export default async function HaulerLog({ input, signal }: ToolRouteProps<typeof inputSchema>) {
  const context = await agent();
  return (
    <LogStream
      loading={loadLogResult(input, { config: requestDaemonConfig(context), signal })}
      names={mcpSurface}
    />
  );
}
