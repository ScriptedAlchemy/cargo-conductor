import { agent, defineOperation, type RscOperationContext } from '@agent-bundle/runtime/plugin';
import * as React from 'react';

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
} from '../lib/protocol-schemas.js';
import { awaitTicketResult, fetchTicketResult, submitTicketRequest } from '../lib/tickets.js';
import { HaulerResult } from '../result.js';

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
      `--max-wait-ms must be at most ${awaitMaxWaitMs} (${awaitMaxWaitMs / 60_000} minutes); use hauler result to poll longer waits`,
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

export const defaultTicketOperations: TicketOperations = {
  await: (input, context) =>
    awaitTicketResult(input, {
      // Heartbeats go to stderr so a terminal `hauler await` shows
      // phase/elapsed/estimate while stdout stays machine-readable.
      onProgress: ({ line }) => {
        process.stderr.write(line);
      },
      signal: context.signal,
    }),
  request: async (input, context) =>
    submitTicketRequest(input, await agent(), { signal: context.signal }),
  result: (input, context) => fetchTicketResult(input, { signal: context.signal }),
};

export const ticketOperations = (operations: TicketOperations) => [
  defineOperation({
    cli: {
      name: 'await',
      parse: parseTicket,
      summary: 'Wait for a hauler ticket to finish.',
      usage: 'await <ticket> [--max-wait-ms N]',
    },
    execute: operations.await,
    id: 'await',
    inputSchema: ticketInputSchema,
    mcp: {
      description: 'Long-poll a cargo-hauler ticket until it finishes or the wait expires.',
      name: 'hauler_await',
      readOnly: true,
      server: 'hauler',
    },
    render: (receipt) => <HaulerResult receipt={receipt} />,
    resultSchema: awaitResultSchema,
  }),
  defineOperation({
    cli: {
      name: 'result',
      parse: parseTicket,
      summary: 'Fetch a durable hauler ticket result.',
      usage: 'result <ticket>',
    },
    execute: operations.result,
    id: 'result',
    inputSchema: ticketInputSchema,
    mcp: {
      description:
        'Fetch one cargo-hauler ticket. Running tickets include a live output-tail snapshot; terminal tickets include the durable ledger result.',
      name: 'hauler_result',
      readOnly: true,
      server: 'hauler',
    },
    render: (receipt) => <HaulerResult receipt={receipt} />,
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
      description:
        'Submit a background cargo request and return a durable ticket id. Host and session are inferred when omitted; explicit fields override inferred attribution.',
      name: 'hauler_request',
      readOnly: false,
      server: 'hauler',
    },
    render: (receipt) => <HaulerResult receipt={receipt} />,
    resultSchema: requestResultSchema,
  }),
];
