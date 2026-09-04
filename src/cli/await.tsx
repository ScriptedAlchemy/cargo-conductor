import { agent } from '@agent-bundle/runtime';
import type { CliRouteConfig, CliRouteProps } from 'agent-bundle';
import React from 'react';
import { z } from 'zod';

import { AwaitStream } from '../components/streaming.js';
import { cliSurface } from '../components/surface.js';
import { awaitCeilingMs } from '../daemon/protocol.js';
import { awaitMaxWaitMessage, awaitResultSchema } from '../lib/protocol-schemas.js';
import { requestDaemonConfig } from '../lib/request-config.js';
import { awaitTicketResult, defaultAwaitMs, fetchTicketResult, progressMessage } from '../lib/tickets.js';

export const config = {
  description: 'Long-poll a ticket until it finishes or the wait expires.',
  positionals: ['ticket'],
  // The daemon's 2 h await ceiling (`awaitCeilingMs`) plus a minute for the
  // snapshot fetch before the wait and the socket round trip after it — a
  // literal, as route config is read statically; `tests/await-budget.test.ts`
  // holds the two together. The host's own tool-call deadline still applies.
  render: { maxElapsedMs: 7_260_000 },
} satisfies CliRouteConfig;

export const inputSchema = z.object({
  ticket: z.string().min(1).describe('Ticket id, e.g. cc-123'),
  maxWaitMs: z
    .number()
    .int()
    .min(0)
    .max(awaitCeilingMs, { message: awaitMaxWaitMessage })
    .optional()
    .describe(
      'Give up after this many milliseconds (default 30000, ceiling 7200000 — the daemon\'s 2 h await ceiling); call again to keep waiting',
    ),
});

export const resultSchema = awaitResultSchema;

export default async function Await({ input, signal }: CliRouteProps<typeof inputSchema>) {
  const context = await agent();
  const daemonConfig = requestDaemonConfig(context);
  const maxWaitMs = input.maxWaitMs ?? defaultAwaitMs;
  const startedAt = Date.now();
  const snapshot = await fetchTicketResult(input, { config: daemonConfig, signal });
  const awaited = awaitTicketResult({ ...input, maxWaitMs }, {
    config: daemonConfig,
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
      names={cliSurface}
      nowMs={startedAt}
      snapshot={snapshot.request}
      ticket={input.ticket}
    />
  );
}
