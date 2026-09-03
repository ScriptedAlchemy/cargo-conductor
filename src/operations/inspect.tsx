import { defineOperation, type RscOperationContext } from '@agent-bundle/runtime/plugin';
import * as React from 'react';

import { APP_RESOURCE_URI } from '../constants.js';
import type { RequestRecord } from '../daemon/protocol.js';
import { loadLastResult, loadLogResult, loadStatusResult } from '../lib/inspect.js';
import {
  lastResultSchema,
  limitInputSchema,
  logResultSchema,
  statusResultSchema,
  statusInputSchema,
  type LastResult,
  type LimitInput,
  type LogResult,
  type StatusResult,
  type StatusInput,
} from '../lib/protocol-schemas.js';
import { HaulerResult } from '../result.js';

export interface InspectOperations {
  readonly last: (input: LimitInput, context: RscOperationContext) => Promise<LastResult>;
  readonly log: (input: LimitInput, context: RscOperationContext) => Promise<LogResult>;
  readonly status: (input: StatusInput, context: RscOperationContext) => Promise<StatusResult>;
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

const parseStatus = (args: readonly string[]): StatusInput => {
  const input: {
    limit?: number;
    cwd?: string;
    session?: string;
    laneKey?: string;
    tickets?: string[];
    statuses?: RequestRecord['status'][];
    commandContains?: string;
  } = {};
  const readValue = (index: number, option: string): string => {
    const value = args[index + 1];
    if (value === undefined || value.startsWith('-')) {
      throw new Error(`${option} requires a value`);
    }
    return value;
  };
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (option === '--limit') {
      input.limit = Number(readValue(index, option));
      index += 1;
    } else if (option === '--cwd') {
      input.cwd = readValue(index, option);
      index += 1;
    } else if (option === '--session') {
      input.session = readValue(index, option);
      index += 1;
    } else if (option === '--lane') {
      input.laneKey = readValue(index, option);
      index += 1;
    } else if (option === '--ticket') {
      (input.tickets ??= []).push(readValue(index, option));
      index += 1;
    } else if (option === '--status') {
      (input.statuses ??= []).push(readValue(index, option) as RequestRecord['status']);
      index += 1;
    } else if (option === '--command-contains') {
      input.commandContains = readValue(index, option);
      index += 1;
    } else {
      throw new Error(`Unknown option: ${option}`);
    }
  }
  const parsed = statusInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error(parsed.error.issues.map((issue) => issue.message).join('; '));
  }
  return parsed.data;
};

export const defaultInspectOperations: InspectOperations = {
  last: (_input, context) => loadLastResult({ signal: context.signal }),
  log: (input, context) => loadLogResult(input, { signal: context.signal }),
  status: (input, context) => loadStatusResult(input, { signal: context.signal }),
};

export const inspectOperations = (operations: InspectOperations) => [
  defineOperation({
    cli: {
      name: 'status',
      parse: parseStatus,
      summary: 'Show queue and in-flight cargo work.',
      usage:
        'status [--limit N] [--cwd PATH] [--session ID] [--lane KEY] [--ticket CC-N] [--status STATUS] [--command-contains TEXT]',
    },
    execute: operations.status,
    id: 'status',
    inputSchema: statusInputSchema,
    mcp: {
      _meta: { ui: { resourceUri: APP_RESOURCE_URI } },
      description:
        'Show cargo-hauler queue and in-flight work. Filter by cwd, session, laneKey, tickets, statuses, or commandContains instead of piping CLI JSON through jq.',
      name: 'hauler_status',
      readOnly: true,
      server: 'hauler',
    },
    render: (receipt) => <HaulerResult receipt={receipt} />,
    resultSchema: statusResultSchema,
  }),
  defineOperation({
    cli: {
      name: 'log',
      parse: parseLimit,
      summary: 'Show recent hauler requests.',
      usage: 'log [--limit N]',
    },
    execute: operations.log,
    id: 'log',
    inputSchema: limitInputSchema,
    mcp: {
      description: 'Show recent cargo-hauler requests from the durable ledger.',
      name: 'hauler_log',
      readOnly: true,
      server: 'hauler',
    },
    render: (receipt) => <HaulerResult receipt={receipt} />,
    resultSchema: logResultSchema,
  }),
  defineOperation({
    cli: {
      name: 'last',
      parse: () => ({}),
      summary: 'Show the most recent hauler request.',
      usage: 'last',
    },
    execute: operations.last,
    id: 'last',
    inputSchema: limitInputSchema,
    mcp: {
      description: 'Show the most recent cargo-hauler request.',
      name: 'hauler_last',
      readOnly: true,
      server: 'hauler',
    },
    render: (receipt) => <HaulerResult receipt={receipt} />,
    resultSchema: lastResultSchema,
  }),
];
