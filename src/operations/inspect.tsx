import { defineOperation, type RscOperationContext } from '@agent-bundle/rsc-runtime/plugin';
import * as React from 'react';
import * as Effect from 'effect/Effect';

import { APP_RESOURCE_URI } from '../constants.js';
import type { RequestRecord } from '../daemon/protocol.js';
import {
  displayRequestRecord,
  displayRequestRecords,
  loadConductorSnapshot,
} from '../query.js';
import { ConductorResult } from '../result.js';

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
} from './schemas.js';

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

const loadSnapshot = (limit: number | undefined) =>
  loadConductorSnapshot(limit === undefined ? {} : { recentLimit: limit });

export const filterStatusRows = (
  rows: readonly RequestRecord[],
  input: StatusInput,
): readonly RequestRecord[] => {
  const tickets = input.tickets === undefined ? null : new Set(input.tickets);
  const statuses = input.statuses === undefined ? null : new Set(input.statuses);
  return rows.filter(
    (row) =>
      (input.cwd === undefined || row.cwd === input.cwd) &&
      (input.session === undefined || row.session === input.session) &&
      (input.laneKey === undefined || row.laneKey === input.laneKey) &&
      (tickets === null || tickets.has(row.ticket)) &&
      (statuses === null || statuses.has(row.status)) &&
      (input.commandContains === undefined ||
        row.argv.join(' ').includes(input.commandContains)),
  );
};

export const statusSummary = (
  daemon: 'running' | 'stopped',
  active: readonly RequestRecord[],
  recent: readonly RequestRecord[],
): string => {
  const commandLimit = 160;
  const header =
    daemon === 'running'
      ? `cargo-conductor daemon is running; ${active.length} active, ${recent.length} recent`
      : `cargo-conductor daemon is not running; ${active.length} active, ${recent.length} recent`;
  if (active.length === 0) {
    return header;
  }
  return [
    header,
    ...active.map((row) => {
      const fullCommand = row.argv.join(' ');
      const command =
        fullCommand.length <= commandLimit
          ? fullCommand
          : `${fullCommand.slice(0, commandLimit - 1)}…`;
      const location = row.session ?? row.cwd;
      return `${row.ticket} ${row.status} ${command} (${location})`;
    }),
  ].join('\n');
};

export const defaultInspectOperations: InspectOperations = {
  last: async (_input, context) => {
    const snapshot = await Effect.runPromise(loadSnapshot(1), { signal: context.signal });
    const request = snapshot.recent[0] ?? null;
    return {
      daemon: snapshot.daemon,
      operation: 'last',
      request: request === null ? null : displayRequestRecord(request),
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
      requests: displayRequestRecords(snapshot.recent),
      summary:
        snapshot.recent.length === 0
          ? 'no conductor requests recorded'
          : `${snapshot.recent.length} recent request${snapshot.recent.length === 1 ? '' : 's'}`,
    };
  },
  status: async (input, context) => {
    const limit = input.limit ?? 20;
    const hasFilters =
      input.cwd !== undefined ||
      input.session !== undefined ||
      input.laneKey !== undefined ||
      input.tickets !== undefined ||
      input.statuses !== undefined ||
      input.commandContains !== undefined;
    const snapshot = await Effect.runPromise(loadSnapshot(hasFilters ? 500 : limit), {
      signal: context.signal,
    });
    const active = filterStatusRows(snapshot.active, input);
    const recent = filterStatusRows(snapshot.recent, input).slice(0, limit);
    return {
      ...snapshot,
      active: displayRequestRecords(active),
      operation: 'status',
      recent: displayRequestRecords(recent),
      summary: statusSummary(snapshot.daemon, active, recent),
    };
  },
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
        'Show cargo-conductor queue and in-flight work. Filter by cwd, session, laneKey, tickets, statuses, or commandContains instead of piping CLI JSON through jq.',
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
