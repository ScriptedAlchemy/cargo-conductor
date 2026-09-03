import { agent } from '@agent-bundle/runtime';
import type { ToolConfig, ToolRouteProps } from 'agent-bundle';
import React from 'react';

import { RequestDocument } from '../../../components/documents.js';
import { mcpSurface } from '../../../components/surface.js';
import { lineageModel } from '../../../components/view-models.js';
import { requestInputSchema, requestResultSchema } from '../../../lib/protocol-schemas.js';
import { requestDaemonConfig } from '../../../lib/request-config.js';
import { submitTicketRequest } from '../../../lib/tickets.js';

export const config = {
  annotations: { readOnlyHint: false },
  description:
    'Submit a background cargo request and return a durable ticket id. Host and session are inferred from the request (the calling conversation when the host provides lineage); explicit fields override inferred attribution.',
  title: 'Submit background cargo request',
} satisfies ToolConfig;

export const inputSchema = requestInputSchema;
export const resultSchema = requestResultSchema;

export default async function HaulerRequest({ input, signal }: ToolRouteProps<typeof inputSchema>) {
  const context = await agent();
  const submitted = await submitTicketRequest(input, context, {
    config: requestDaemonConfig(context),
    signal,
  });
  return (
    <RequestDocument
      argv={input.argv}
      lineage={lineageModel(context.lineage)}
      names={mcpSurface}
      result={submitted}
    />
  );
}
