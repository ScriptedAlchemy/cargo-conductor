import { agent } from '@agent-bundle/runtime';
import type { ToolConfig, ToolRouteProps } from 'agent-bundle';
import React from 'react';

import { RequestDocument } from '../../../components/documents.js';
import { mcpSurface } from '../../../components/surface.js';
import { requestInputSchema, requestResultSchema } from '../../../lib/protocol-schemas.js';
import { requestDaemonConfig } from '../../../lib/request-config.js';
import { submitTicketRequest } from '../../../lib/tickets.js';

export const config = {
  annotations: { readOnlyHint: false },
  description:
    'Submit a background cargo request and return a durable ticket id. Host and session are inferred when omitted; explicit fields override inferred attribution.',
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
  return <RequestDocument argv={input.argv} names={mcpSurface} result={submitted} />;
}
