import { Agent, agent } from '@agent-bundle/runtime';
import type { ToolConfig, ToolRouteProps } from 'agent-bundle';
import React from 'react';

import { requestInputSchema, requestResultSchema } from '../../../lib/protocol-schemas.js';
import { requestDaemonConfig } from '../../../lib/request-config.js';
import { submitTicketRequest } from '../../../lib/tickets.js';
import { documentValue } from '../../../lib/json.js';

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
  return (
    <Agent.Result value={documentValue(submitted)}>
      <Agent.Text>{submitted.summary}</Agent.Text>
      {submitted.ticket === null ? (
        <Agent.Error code="submit-failed">
          {`The daemon did not accept ${input.argv.join(' ')}; run hauler daemon status or check the daemon log.`}
        </Agent.Error>
      ) : (
        <Agent.Context>
          {`Ticket ${submitted.ticket} is running in the background. Continue other work; when the session has a hold-stop ticket the stop hook waits for it. Retrieve with hauler_result ${submitted.ticket}, or block with hauler_await ${submitted.ticket}.`}
        </Agent.Context>
      )}
    </Agent.Result>
  );
}
