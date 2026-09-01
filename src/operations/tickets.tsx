import { defineOperation, type RscOperationContext } from '@agent-bundle/rsc-runtime/plugin';
import * as React from 'react';
import * as Cause from 'effect/Cause';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Option from 'effect/Option';

import { awaitTicket, fetchTicket, submitBackground, type TicketSocketError } from '../client/tickets.js';
import { ConductorResult } from '../result.js';

import {
  awaitMaxWaitMs,
  awaitResultSchema,
  requestInputSchema,
  requestResultSchema,
  resultFetchResultSchema,
  ticketInputSchema,
  type AwaitResult,
  type RequestInput,
  type RequestSubmitResult,
  type ResultFetchResult,
  type TicketInput,
} from './schemas.js';

export interface TicketOperations {
  readonly await: (input: TicketInput, context: RscOperationContext) => Promise<AwaitResult>;
  readonly request: (input: RequestInput, context: RscOperationContext) => Promise<RequestSubmitResult>;
  readonly result: (input: TicketInput, context: RscOperationContext) => Promise<ResultFetchResult>;
}

const parseTicket = (args: readonly string[]): TicketInput => {
  const ticket = args.find((argument) => !argument.startsWith('-'));
  if (ticket === undefined) {
    throw new Error('ticket id is required');
  }
  const waitIndex = args.indexOf('--max-wait-ms');
  if (waitIndex === -1) {
    return { ticket };
  }
  const raw = args[waitIndex + 1];
  const maxWaitMs = Number(raw);
  if (raw === undefined || !Number.isInteger(maxWaitMs) || maxWaitMs < 0) {
    throw new Error('--max-wait-ms requires a non-negative integer');
  }
  if (maxWaitMs > awaitMaxWaitMs) {
    throw new Error(
      `--max-wait-ms must be at most ${awaitMaxWaitMs} (${awaitMaxWaitMs / 60_000} minutes); use conductor result to poll longer waits`,
    );
  }
  return { maxWaitMs, ticket };
};

const parseRequest = (args: readonly string[]): RequestInput => {
  const cwdIndex = args.indexOf('--cwd');
  const sessionIndex = args.indexOf('--session');
  const hostIndex = args.indexOf('--host');
  const dash = args.indexOf('--');
  const argv = dash === -1 ? args.filter((argument) => !argument.startsWith('-')) : args.slice(dash + 1);
  if (argv.length === 0) {
    throw new Error('request requires a cargo command');
  }
  return {
    argv,
    cwd: cwdIndex === -1 ? process.cwd() : (args[cwdIndex + 1] ?? process.cwd()),
    ...(sessionIndex === -1 ? {} : { session: args[sessionIndex + 1] }),
    ...(hostIndex === -1 ? {} : { host: args[hostIndex + 1] }),
  };
};

const describeRecord = (ticket: string, request: AwaitResult['request']): string => {
  if (request === null) {
    return `${ticket} not found`;
  }
  return `${request.ticket} ${request.status}`;
};

const infraFailure = (error: TicketSocketError): Error => {
  switch (error._tag) {
    case 'DaemonUnreachable':
      return new Error(
        `conductor daemon unreachable at ${error.socketPath}; it starts on demand with any exec, or run: conductor daemon start`,
      );
    case 'ControlTimeout':
      return new Error(
        `conductor daemon did not answer within ${error.timeoutMs}ms (socket ${error.socketPath})`,
      );
    case 'ConnectionClosed':
      return new Error(
        `connection to the conductor daemon closed mid-request (socket ${error.socketPath})`,
      );
    default: {
      const exhaustive: never = error;
      return exhaustive;
    }
  }
};

/**
 * Boundary runner: MCP/CLI cancellation aborts the socket wait, and typed
 * infrastructure failures surface as clear tool errors instead of being
 * disguised as "not found" / "timed out".
 */
const runTicketEffect = async <A,>(
  effect: Effect.Effect<A, TicketSocketError>,
  signal: AbortSignal,
): Promise<A> => {
  const exit = await Effect.runPromiseExit(effect, { signal });
  if (Exit.isSuccess(exit)) {
    return exit.value;
  }
  const failure = Cause.findErrorOption(exit.cause);
  if (Option.isSome(failure)) {
    throw infraFailure(failure.value);
  }
  throw Cause.squash(exit.cause);
};

export const defaultTicketOperations: TicketOperations = {
  await: async (input, context) => {
    const waited = await runTicketEffect(
      awaitTicket(input.ticket, input.maxWaitMs ?? 30_000),
      context.signal,
    );
    return {
      operation: 'await',
      request: waited.request,
      summary: waited.timedOut
        ? `${input.ticket} still pending`
        : describeRecord(input.ticket, waited.request),
      ticket: input.ticket,
      timedOut: waited.timedOut,
    };
  },
  request: async (input, context) => {
    const ticket = await runTicketEffect(submitBackground(input), context.signal);
    return {
      operation: 'request',
      summary: ticket === null ? 'failed to submit background request' : `${ticket} submitted`,
      ticket,
    };
  },
  result: async (input, context) => {
    const request = await runTicketEffect(fetchTicket(input.ticket), context.signal);
    return {
      operation: 'result',
      request,
      summary: describeRecord(input.ticket, request),
      ticket: input.ticket,
    };
  },
};

export const ticketOperations = (operations: TicketOperations) => [
  defineOperation({
    cli: {
      name: 'await',
      parse: parseTicket,
      summary: 'Wait for a conductor ticket to finish.',
      usage: 'await <ticket> [--max-wait-ms N]',
    },
    execute: operations.await,
    id: 'await',
    inputSchema: ticketInputSchema,
    mcp: {
      description: 'Long-poll a cargo-conductor ticket until it finishes or the wait expires.',
      name: 'conductor_await',
      readOnly: true,
      server: 'conductor',
    },
    render: (receipt) => <ConductorResult receipt={receipt} />,
    resultSchema: awaitResultSchema,
  }),
  defineOperation({
    cli: {
      name: 'result',
      parse: parseTicket,
      summary: 'Fetch a durable conductor ticket result.',
      usage: 'result <ticket>',
    },
    execute: operations.result,
    id: 'result',
    inputSchema: ticketInputSchema,
    mcp: {
      description: 'Fetch a durable cargo-conductor ticket result from the ledger.',
      name: 'conductor_result',
      readOnly: true,
      server: 'conductor',
    },
    render: (receipt) => <ConductorResult receipt={receipt} />,
    resultSchema: resultFetchResultSchema,
  }),
  defineOperation({
    cli: {
      name: 'request',
      parse: parseRequest,
      summary: 'Submit cargo in the background and return a ticket.',
      usage: 'request [--session ID] [--cwd DIR] -- <cargo command>',
    },
    execute: operations.request,
    id: 'request',
    inputSchema: requestInputSchema,
    mcp: {
      description: 'Submit a background cargo request and return a durable ticket id.',
      name: 'conductor_request',
      readOnly: false,
      server: 'conductor',
    },
    render: (receipt) => <ConductorResult receipt={receipt} />,
    resultSchema: requestResultSchema,
  }),
];
