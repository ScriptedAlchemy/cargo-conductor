import { agent } from '@agent-bundle/runtime';
import type { ToolConfig, ToolRouteProps } from 'agent-bundle';
import React from 'react';

import { AwaitDocument } from '../../../components/documents.js';
import { mcpSurface } from '../../../components/surface.js';
import { awaitResultSchema, ticketInputSchema } from '../../../lib/protocol-schemas.js';
import { requestDaemonConfig } from '../../../lib/request-config.js';
import { awaitTicketResult, defaultAwaitMs, progressMessage } from '../../../lib/tickets.js';

export const config = {
  annotations: { readOnlyHint: true },
  description:
    'Long-poll a cargo-hauler ticket until it finishes or the wait expires (maxWaitMs up to two hours). Progress notifications carry queue position, elapsed time, and the cost estimate while waiting.',
  title: 'Await hauler ticket',
} satisfies ToolConfig;

export const inputSchema = ticketInputSchema;
export const resultSchema = awaitResultSchema;

export default async function HaulerAwait({ input, signal }: ToolRouteProps<typeof inputSchema>) {
  const context = await agent();
  const maxWaitMs = input.maxWaitMs ?? defaultAwaitMs;
  const startedAt = Date.now();
  const awaited = await awaitTicketResult(input, {
    config: requestDaemonConfig(context),
    // Heartbeats become MCP progress notifications. Progress is best-effort:
    // a host that cannot deliver it must not fail the wait.
    onProgress: ({ line }) => {
      void context.progress
        .report({
          completed: Math.min(maxWaitMs, Date.now() - startedAt),
          message: progressMessage(line),
          total: maxWaitMs,
        })
        .catch(() => undefined);
    },
    signal,
  });
  return <AwaitDocument maxWaitMs={maxWaitMs} names={mcpSurface} nowMs={Date.now()} result={awaited} />;
}
