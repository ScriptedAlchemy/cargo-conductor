import { agent } from '@agent-bundle/runtime';
import type { CliRouteConfig, CliRouteProps } from 'agent-bundle';
import React from 'react';
import { z } from 'zod';

import { KillDocument } from '../components/documents.js';
import { cliSurface } from '../components/surface.js';
import { killResultSchema } from '../lib/protocol-schemas.js';
import { requestDaemonConfig } from '../lib/request-config.js';
import { killTicketResult } from '../lib/tickets.js';

export const config = {
  description:
    'Stop a ticket: drop it from the queue or terminate its cargo process, freeing the lane for the requests behind it.',
  positionals: ['ticket'],
} satisfies CliRouteConfig;

export const inputSchema = z.object({
  ticket: z.string().min(1).describe('Ticket id, e.g. cc-123'),
});

export const resultSchema = killResultSchema;

export default async function Kill({ input, signal }: CliRouteProps<typeof inputSchema>) {
  const context = await agent();
  const result = await killTicketResult(input, { config: requestDaemonConfig(context), signal });
  return <KillDocument names={cliSurface} nowMs={Date.now()} result={result} />;
}
