import {
  awaitTicketWithProgress,
  fetchTicket,
  submitBackground,
  type AwaitProgress,
} from '../client/tickets.js';
import type { DaemonConfigShape } from '../daemon/config.js';
import type { RequestRecord } from '../daemon/protocol.js';
import { describeRequestRecord, displayRequestRecord } from '../query.js';

import type { TicketRequestContext } from './attribution.js';
import { enrichTicketRequest, ticketAttribution } from './attribution.js';
import type {
  AwaitResult,
  RequestInput,
  RequestSubmitResult,
  ResultFetchResult,
  TicketInput,
} from './protocol-schemas.js';
import { runTicketEffect } from './ticket-errors.js';

export interface TicketOptions {
  readonly config?: DaemonConfigShape;
  readonly signal: AbortSignal;
}

export interface AwaitOptions extends TicketOptions {
  /** Heartbeats while waiting; the caller decides how (or whether) to surface them. */
  readonly onProgress?: (progress: AwaitProgress) => void;
}

export const defaultAwaitMs = 30_000;

/** A heartbeat line without the `[cargo-hauler]` prefix, for progress channels that label the source themselves. */
export const progressMessage = (line: string): string =>
  line.replace(/^\[cargo-hauler\]\s*/u, '').trimEnd();

/**
 * Records cross from storage (ANSI kept) to a structured result here. Both
 * transports serialize the result to JSON — the CLI prints it, the MCP
 * server ships it as structured content — so the projection always strips:
 * an inherited FORCE_COLOR/CLICOLOR_FORCE must not leave ESC bytes to become
 * literal `\u001b[…` in the JSON.
 */
const requestForConsumer = (request: RequestRecord | null): RequestRecord | null =>
  request === null ? null : displayRequestRecord(request);

export const awaitTicketResult = async (
  input: TicketInput,
  options: AwaitOptions,
): Promise<AwaitResult> => {
  const waited = await runTicketEffect(
    awaitTicketWithProgress(
      input.ticket,
      input.maxWaitMs ?? defaultAwaitMs,
      options.onProgress ?? (() => undefined),
      options.config,
    ),
    options.signal,
  );
  return {
    operation: 'await',
    request: requestForConsumer(waited.request),
    summary: waited.timedOut
      ? `${input.ticket} still pending`
      : describeRequestRecord(input.ticket, waited.request),
    ticket: input.ticket,
    timedOut: waited.timedOut,
  };
};

export const fetchTicketResult = async (
  input: Pick<TicketInput, 'ticket'>,
  options: TicketOptions,
): Promise<ResultFetchResult> => {
  const request = await runTicketEffect(fetchTicket(input.ticket, options.config), options.signal);
  return {
    operation: 'result',
    request: requestForConsumer(request),
    summary: describeRequestRecord(input.ticket, request),
    ticket: input.ticket,
  };
};

export const submitTicketRequest = async (
  input: RequestInput,
  requestContext: TicketRequestContext,
  options: TicketOptions,
): Promise<RequestSubmitResult> => {
  const attribution = ticketAttribution(input, requestContext);
  const ticket = await runTicketEffect(
    submitBackground(enrichTicketRequest(input, requestContext), options.config),
    options.signal,
  );
  return {
    attribution,
    operation: 'request',
    summary: ticket === null ? 'failed to submit background request' : `${ticket} submitted`,
    ticket,
  };
};
