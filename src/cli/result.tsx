import { agent } from '@agent-bundle/runtime';
import type { CliRouteConfig, CliRouteProps } from 'agent-bundle';
import React from 'react';
import { z } from 'zod';

import { ResultDocument } from '../components/documents.js';
import { cliSurface } from '../components/surface.js';
import { resultFetchResultSchema } from '../lib/protocol-schemas.js';
import { requestDaemonConfig } from '../lib/request-config.js';
import { fetchTicketResult } from '../lib/tickets.js';

export const config = {
  description: 'Read a stored ticket result (running tickets include a live output tail).',
  positionals: ['ticket'],
} satisfies CliRouteConfig;

export const inputSchema = z.object({
  ticket: z.string().min(1).describe('Ticket id, e.g. cc-123'),
});

export const resultSchema = resultFetchResultSchema;

export default async function Result({ input, signal }: CliRouteProps<typeof inputSchema>) {
  const context = await agent();
  const result = await fetchTicketResult(input, { config: requestDaemonConfig(context), signal });
  return <ResultDocument names={cliSurface} nowMs={Date.now()} result={result} />;
}
