import { agent } from '@agent-bundle/runtime';
import type { CliRouteConfig, CliRouteProps } from 'agent-bundle';
import React from 'react';
import { z } from 'zod';

import { RequestDocument } from '../components/documents.js';
import { cliSurface } from '../components/surface.js';
import { requestResultSchema } from '../lib/protocol-schemas.js';
import { requestDaemonConfig } from '../lib/request-config.js';
import { submitTicketRequest } from '../lib/tickets.js';

export const config = {
  description: 'Submit a background cargo request and print its ticket: hauler request -- cargo check -p foo',
  positionals: ['argv'],
} satisfies CliRouteConfig;

export const inputSchema = z.object({
  argv: z.array(z.string()).min(1).describe('The cargo command, after --'),
  cwd: z.string().min(1).optional().describe('Workspace directory (default: current directory)'),
  session: z.string().min(1).optional().describe('Agent session id for attribution'),
  host: z.string().min(1).optional().describe('Agent host name for attribution'),
});

export const resultSchema = requestResultSchema;

export default async function Request({ input, signal }: CliRouteProps<typeof inputSchema>) {
  const context = await agent();
  const submitted = await submitTicketRequest(
    {
      argv: input.argv,
      cwd: input.cwd ?? process.cwd(),
      ...(input.session === undefined ? {} : { session: input.session }),
      ...(input.host === undefined ? {} : { host: input.host }),
    },
    context,
    { config: requestDaemonConfig(context), signal },
  );
  return <RequestDocument argv={input.argv} names={cliSurface} result={submitted} />;
}
