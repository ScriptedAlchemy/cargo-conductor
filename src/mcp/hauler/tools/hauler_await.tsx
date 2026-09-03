import { agent } from '@agent-bundle/runtime';
import type { ToolConfig, ToolRouteProps } from 'agent-bundle';
import React from 'react';

import { AwaitStream } from '../../../components/streaming.js';
import { mcpSurface } from '../../../components/surface.js';
import { awaitResultSchema, ticketInputSchema } from '../../../lib/protocol-schemas.js';
import { requestDaemonConfig } from '../../../lib/request-config.js';
import { awaitTicketResult, defaultAwaitMs, fetchTicketResult, progressMessage } from '../../../lib/tickets.js';

export const config = {
  annotations: { readOnlyHint: true },
  description:
    'Long-poll a cargo-hauler ticket until it finishes or the wait expires (maxWaitMs up to two hours). The document streams: the live ticket card first, then the settled result; progress notifications carry queue position, elapsed time, and the cost estimate while waiting.',
  title: 'Await hauler ticket',
} satisfies ToolConfig;

export const inputSchema = ticketInputSchema;
export const resultSchema = awaitResultSchema;

export default async function HaulerAwait({ input, signal }: ToolRouteProps<typeof inputSchema>) {
  const context = await agent();
  const daemonConfig = requestDaemonConfig(context);
  const maxWaitMs = input.maxWaitMs ?? defaultAwaitMs;
  const startedAt = Date.now();
  // The shell frame: the ticket as it is right now, before the wait blocks.
  const snapshot = await fetchTicketResult(input, { config: daemonConfig, signal });
  const awaited = awaitTicketResult(input, {
    config: daemonConfig,
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
  // The settled component awaits this promise; the no-op handler only keeps a
  // rejection that lands before render attaches from surfacing as unhandled.
  awaited.catch(() => undefined);
  return (
    <AwaitStream
      awaited={awaited}
      maxWaitMs={maxWaitMs}
      names={mcpSurface}
      nowMs={startedAt}
      snapshot={snapshot.request}
      ticket={input.ticket}
    />
  );
}
