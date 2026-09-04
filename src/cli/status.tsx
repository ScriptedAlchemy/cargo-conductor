import { agent } from '@agent-bundle/runtime';
import type { CliRouteConfig, CliRouteProps } from 'agent-bundle';
import React from 'react';
import { z } from 'zod';

import { StatusDocument } from '../components/documents.js';
import { cliSurface } from '../components/surface.js';
import { loadStatusResult } from '../lib/inspect.js';
import { statusResultSchema } from '../lib/protocol-schemas.js';
import { requestDaemonConfig } from '../lib/request-config.js';
import { hasStatusFilters } from '../lib/status-filter.js';

export const config = {
  description: 'Show the queue, in-flight cargo work, lanes, and admission state.',
} satisfies CliRouteConfig;

// Redeclared inline (not imported from protocol-schemas): the compiler reads
// the argv grammar statically from this literal (AB4814), so the status list
// cannot reference `requestStatuses`; tests/schema-compat.test.ts pins the two
// together. Keys spell the legacy flags.
export const inputSchema = z.object({
  limit: z.number().int().min(1).max(500).optional().describe('Recent rows to show'),
  cwd: z.string().min(1).optional().describe('Only requests from this workspace'),
  session: z.string().min(1).optional().describe('Only requests from this agent session'),
  lane: z.string().min(1).optional().describe('Only requests in this lane key'),
  ticket: z.array(z.string().min(1)).max(100).optional().describe('Only these tickets (repeatable)'),
  status: z
    .array(z.enum(['requested', 'queued', 'running', 'done', 'failed', 'killed', 'denied', 'passthrough']))
    .max(8)
    .optional()
    .describe('Only these statuses (repeatable)'),
  commandContains: z.string().min(1).optional().describe('Only commands containing this text'),
});

export const resultSchema = statusResultSchema;

export default async function Status({ input, signal }: CliRouteProps<typeof inputSchema>) {
  const context = await agent();
  const filters = {
    ...(input.limit === undefined ? {} : { limit: input.limit }),
    ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
    ...(input.session === undefined ? {} : { session: input.session }),
    ...(input.lane === undefined ? {} : { laneKey: input.lane }),
    ...(input.ticket === undefined ? {} : { tickets: input.ticket }),
    ...(input.status === undefined ? {} : { statuses: input.status }),
    ...(input.commandContains === undefined ? {} : { commandContains: input.commandContains }),
  };
  const status = await loadStatusResult(filters, { config: requestDaemonConfig(context), signal });
  return (
    <StatusDocument
      filtered={hasStatusFilters(filters)}
      names={cliSurface}
      nowMs={Date.now()}
      result={status}
    />
  );
}
