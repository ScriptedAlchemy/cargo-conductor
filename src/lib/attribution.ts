import type { AgentRequestContext } from '@agent-bundle/runtime';

import type { RequestInput, TicketAttribution } from './protocol-schemas.js';

export type TicketRequestContext = Pick<AgentRequestContext, 'host' | 'lineage' | 'session'> & {
  readonly invocation: Pick<AgentRequestContext['invocation'], 'kind'>;
};

/**
 * Who asked for this ticket. Explicit host/session win; otherwise attribution
 * comes from the observed request context. Bare-stdio MCP hosts publish no
 * session id, so `request.lineage` — the conversation the host placed this
 * call in — is the session of record there, which is what makes parallel
 * agents' builds attributable in the ledger, the dashboard, and
 * `hauler status --session`. The transport kind is the last fallback so a
 * ticket is never recorded as anonymous.
 */
export const ticketAttribution = (
  input: Pick<RequestInput, 'argv' | 'cwd' | 'host' | 'session'>,
  requestContext: TicketRequestContext,
): TicketAttribution => {
  const lineage = requestContext.lineage.state === 'available' ? requestContext.lineage.value : null;
  const host = input.host
    ?? (requestContext.host.state === 'available'
      ? requestContext.host.value.name
      : requestContext.invocation.kind === 'cli'
        ? 'cli'
        : 'mcp');
  const session = input.session
    ?? (requestContext.session.state === 'available'
      ? requestContext.session.value.sessionId
      : lineage?.conversation ?? null);
  return {
    host,
    lineage: lineage === null
      ? null
      : {
          conversation: lineage.conversation,
          depth: lineage.depth,
          ...(lineage.parent === undefined ? {} : { parent: lineage.parent }),
          resolution: lineage.resolution,
          root: lineage.root,
        },
    session,
  };
};

export const enrichTicketRequest = (
  input: RequestInput,
  requestContext: TicketRequestContext,
): RequestInput => {
  const attribution = ticketAttribution(input, requestContext);
  return {
    ...input,
    host: attribution.host,
    ...(attribution.session === null ? {} : { session: attribution.session }),
  };
};
