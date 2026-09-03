import { agent } from '@agent-bundle/runtime';
import type { ToolConfig, ToolRouteProps } from 'agent-bundle';
import React from 'react';
import { z } from 'zod';

import { KillDocument } from '../../../components/documents.js';
import { mcpSurface } from '../../../components/surface.js';
import { killResultSchema } from '../../../lib/protocol-schemas.js';
import { requestDaemonConfig } from '../../../lib/request-config.js';
import { killTicketResult } from '../../../lib/tickets.js';

export const config = {
  annotations: { destructiveHint: true, idempotentHint: true },
  description:
    'Stop a cargo-hauler ticket: a queued request is dropped, a running one has its cargo process terminated (SIGTERM, then SIGKILL after the grace period) and its lane freed. Use this instead of killing cargo PIDs — the daemon settles riders and the ledger. Returns killed: false when the ticket is unknown or already finished.',
  title: 'Kill hauler ticket',
} satisfies ToolConfig;

export const inputSchema = z.object({
  ticket: z.string().min(1).describe('Ticket id, e.g. cc-123'),
});
export const resultSchema = killResultSchema;

export default async function HaulerKill({ input, signal }: ToolRouteProps<typeof inputSchema>) {
  const context = await agent();
  const result = await killTicketResult(input, { config: requestDaemonConfig(context), signal });
  return <KillDocument names={mcpSurface} nowMs={Date.now()} result={result} />;
}
