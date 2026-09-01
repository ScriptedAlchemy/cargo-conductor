import { defineOperation, type RscOperationContext } from '@agent-bundle/rsc-runtime/plugin';
import * as React from 'react';
import * as Effect from 'effect/Effect';

import { APP_RESOURCE_URI } from '../constants.js';
import { loadConductorSnapshot } from '../query.js';
import { ConductorResult } from '../result.js';

import {
  lastResultSchema,
  limitInputSchema,
  logResultSchema,
  statusResultSchema,
  type LastResult,
  type LimitInput,
  type LogResult,
  type StatusResult,
} from './schemas.js';

export interface InspectOperations {
  readonly last: (input: LimitInput, context: RscOperationContext) => Promise<LastResult>;
  readonly log: (input: LimitInput, context: RscOperationContext) => Promise<LogResult>;
  readonly status: (input: LimitInput, context: RscOperationContext) => Promise<StatusResult>;
}

const parseLimit = (args: readonly string[]): LimitInput => {
  const unknownOption = args.find(
    (argument, index) =>
      argument.startsWith('-') && argument !== '--limit' && args[index - 1] !== '--limit',
  );
  if (unknownOption !== undefined) {
    throw new Error(`Unknown option: ${unknownOption}`);
  }
  const limitIndex = args.indexOf('--limit');
  if (limitIndex === -1) {
    return {};
  }
  const raw = args[limitIndex + 1];
  const limit = Number(raw);
  if (raw === undefined || !Number.isInteger(limit) || limit < 1) {
    throw new Error('--limit requires a positive integer');
  }
  return { limit };
};

const loadSnapshot = (limit: number | undefined) =>
  loadConductorSnapshot(limit === undefined ? {} : { recentLimit: limit });

export const defaultInspectOperations: InspectOperations = {
  last: async (_input, context) => {
    const snapshot = await Effect.runPromise(loadSnapshot(1), { signal: context.signal });
    const request = snapshot.recent[0] ?? null;
    return {
      daemon: snapshot.daemon,
      operation: 'last',
      request,
      summary: request === null ? 'no conductor requests recorded' : `${request.ticket} ${request.status}`,
    };
  },
  log: async (input, context) => {
    const snapshot = await Effect.runPromise(loadSnapshot(input.limit ?? 50), {
      signal: context.signal,
    });
    return {
      daemon: snapshot.daemon,
      operation: 'log',
      requests: snapshot.recent,
      summary:
        snapshot.recent.length === 0
          ? 'no conductor requests recorded'
          : `${snapshot.recent.length} recent request${snapshot.recent.length === 1 ? '' : 's'}`,
    };
  },
  status: async (input, context) => {
    const snapshot = await Effect.runPromise(loadSnapshot(input.limit ?? 20), {
      signal: context.signal,
    });
    return {
      ...snapshot,
      operation: 'status',
    };
  },
};

export const inspectOperations = (operations: InspectOperations) => [
  defineOperation({
    cli: {
      name: 'status',
      parse: parseLimit,
      summary: 'Show queue and in-flight cargo work.',
      usage: 'status [--limit N]',
    },
    execute: operations.status,
    id: 'status',
    inputSchema: limitInputSchema,
    mcp: {
      _meta: { ui: { resourceUri: APP_RESOURCE_URI } },
      description: 'Show the cargo-conductor daemon queue and in-flight cargo work.',
      name: 'conductor_status',
      readOnly: true,
      server: 'conductor',
    },
    render: (receipt) => <ConductorResult receipt={receipt} />,
    resultSchema: statusResultSchema,
  }),
  defineOperation({
    cli: {
      name: 'log',
      parse: parseLimit,
      summary: 'Show recent conductor requests.',
      usage: 'log [--limit N]',
    },
    execute: operations.log,
    id: 'log',
    inputSchema: limitInputSchema,
    mcp: {
      description: 'Show recent cargo-conductor requests from the durable ledger.',
      name: 'conductor_log',
      readOnly: true,
      server: 'conductor',
    },
    render: (receipt) => <ConductorResult receipt={receipt} />,
    resultSchema: logResultSchema,
  }),
  defineOperation({
    cli: {
      name: 'last',
      parse: () => ({}),
      summary: 'Show the most recent conductor request.',
      usage: 'last',
    },
    execute: operations.last,
    id: 'last',
    inputSchema: limitInputSchema,
    mcp: {
      description: 'Show the most recent cargo-conductor request.',
      name: 'conductor_last',
      readOnly: true,
      server: 'conductor',
    },
    render: (receipt) => <ConductorResult receipt={receipt} />,
    resultSchema: lastResultSchema,
  }),
];
