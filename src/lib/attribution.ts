import type { AgentRequestContext } from '@agent-bundle/runtime/plugin';

import type { RequestInput } from './protocol-schemas.js';

export type TicketRequestContext = Pick<AgentRequestContext, 'host' | 'session'> & {
  readonly invocation: Pick<AgentRequestContext['invocation'], 'kind'>;
};

/**
 * Explicit host/session win; otherwise attribution comes from the observed
 * request context, falling back to the transport kind so a ticket is never
 * recorded as anonymous.
 */
export const enrichTicketRequest = (
  input: RequestInput,
  requestContext: TicketRequestContext,
): RequestInput => {
  const host = input.host
    ?? (requestContext.host.state === 'available'
      ? requestContext.host.value.name
      : requestContext.invocation.kind === 'cli'
        ? 'cli'
        : 'mcp');
  const session = input.session
    ?? (requestContext.session.state === 'available'
      ? requestContext.session.value.sessionId
      : undefined);
  return {
    ...input,
    host,
    ...(session === undefined ? {} : { session }),
  };
};
