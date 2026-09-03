import { agent } from '@agent-bundle/runtime';
import type { CliRouteConfig, CliRouteProps } from 'agent-bundle';
import React from 'react';
import { z } from 'zod';

import { LogStream } from '../components/streaming.js';
import { cliSurface } from '../components/surface.js';
import { loadLogResult } from '../lib/inspect.js';
import { logResultSchema } from '../lib/protocol-schemas.js';
import { requestDaemonConfig } from '../lib/request-config.js';

export const config = {
  description: 'List recent hauler requests from the ledger, newest first.',
} satisfies CliRouteConfig;

export const inputSchema = z.object({
  limit: z.number().int().min(1).max(500).optional().describe('Rows to show'),
});

export const resultSchema = logResultSchema;

export default async function Log({ input, signal }: CliRouteProps<typeof inputSchema>) {
  const context = await agent();
  return (
    <LogStream
      loading={loadLogResult(input, { config: requestDaemonConfig(context), signal })}
      names={cliSurface}
    />
  );
}
