import { agent } from '@agent-bundle/runtime';
import type { CliRouteConfig, CliRouteProps } from 'agent-bundle';
import React from 'react';
import { z } from 'zod';

import { AwaitDocument } from '../components/documents.js';
import { cliSurface } from '../components/surface.js';
import { awaitResultSchema } from '../lib/protocol-schemas.js';
import { requestDaemonConfig } from '../lib/request-config.js';
import { awaitTicketResult, defaultAwaitMs, progressMessage } from '../lib/tickets.js';

export const config = {
  description: 'Long-poll a ticket until it finishes or the wait expires.',
  positionals: ['ticket'],
} satisfies CliRouteConfig;

export const inputSchema = z.object({
  ticket: z.string().min(1).describe('Ticket id, e.g. cc-123'),
  maxWaitMs: z
    .number()
    .int()
    .min(0)
    .max(7_200_000)
    .optional()
    .describe('Give up after this many milliseconds (default 30000, ceiling two hours)'),
});

export const resultSchema = awaitResultSchema;

export default async function Await({ input, signal }: CliRouteProps<typeof inputSchema>) {
  const context = await agent();
  const maxWaitMs = input.maxWaitMs ?? defaultAwaitMs;
  const startedAt = Date.now();
  const awaited = await awaitTicketResult(input, {
    config: requestDaemonConfig(context),
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
  return <AwaitDocument maxWaitMs={maxWaitMs} names={cliSurface} nowMs={Date.now()} result={awaited} />;
}
