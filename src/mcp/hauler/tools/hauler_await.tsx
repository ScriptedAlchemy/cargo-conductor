import { Agent, agent } from '@agent-bundle/runtime';
import type { ToolConfig, ToolRouteProps } from 'agent-bundle';
import React from 'react';

import { TicketCard, TicketGuidance } from '../../../components/ticket-card.js';
import { formatMs } from '../../../lib/format.js';
import { awaitResultSchema, ticketInputSchema } from '../../../lib/protocol-schemas.js';
import { requestDaemonConfig } from '../../../lib/request-config.js';
import { awaitTicketResult, defaultAwaitMs } from '../../../lib/tickets.js';

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
    // Heartbeats become MCP progress notifications; the line already carries
    // phase, elapsed, estimate, and queue position. Progress is best-effort,
    // so a host that cannot deliver it must not fail the wait.
    onProgress: ({ line }) => {
      void context.progress
        .report({
          completed: Math.min(maxWaitMs, Date.now() - startedAt),
          message: line.replace(/^\[cargo-hauler\]\s*/u, '').trimEnd(),
          total: maxWaitMs,
        })
        .catch(() => undefined);
    },
    signal,
  });
  const nowMs = Date.now();
  return (
    <Agent.Result value={awaited}>
      <Agent.Text>{awaited.summary}</Agent.Text>
      {awaited.request === null ? null : <TicketCard nowMs={nowMs} record={awaited.request} />}
      {awaited.timedOut ? (
        <Agent.Context>
          {`The ${formatMs(maxWaitMs)} wait expired before ${input.ticket} finished. Call hauler_await again with a larger maxWaitMs (up to 7200000) rather than polling hauler_result in a tight loop.`}
        </Agent.Context>
      ) : awaited.request === null ? (
        <Agent.Context>{`${input.ticket} is not known to the daemon; check hauler_log for recent ticket ids.`}</Agent.Context>
      ) : (
        <TicketGuidance record={awaited.request} />
      )}
    </Agent.Result>
  );
}
