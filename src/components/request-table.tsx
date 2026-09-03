import { Agent } from '@agent-bundle/runtime';
import React from 'react';

import type { RequestRecord } from '../daemon/protocol.js';
import { formatMs, relativeTime, shortenPath } from '../lib/format.js';

import { commandText, elapsedMs } from './headlines.js';
import { Heading, Table } from './primitives.js';

export interface RequestTableProps {
  readonly heading?: string;
  readonly nowMs: number;
  readonly records: readonly RequestRecord[];
  /** Shown when there are no rows, instead of an empty table. */
  readonly empty?: string;
}

const outcome = (record: RequestRecord, nowMs: number): string => {
  const elapsed = elapsedMs(record, nowMs);
  const timing = elapsed === null ? '' : ` ${formatMs(elapsed)}`;
  switch (record.status) {
    case 'queued':
      return record.queue === undefined
        ? `queued${timing}`
        : `queued${timing} · ${record.queue.position} ahead`;
    case 'running':
      return record.estimateMs === null ? `running${timing}` : `running${timing} / ~${formatMs(record.estimateMs)}`;
    case 'done':
      return record.attachedTo === null ? `done${timing}` : `done${timing} · rode ${record.attachedTo}`;
    case 'failed':
      return `failed${timing}${record.exitCode === null ? '' : ` exit=${record.exitCode}`}`;
    case 'requested':
    case 'killed':
    case 'denied':
    case 'passthrough':
      return `${record.status}${timing}`;
    default: {
      const exhaustive: never = record.status;
      return exhaustive;
    }
  }
};

const where = (record: RequestRecord): string =>
  [record.host, record.session, shortenPath(record.cwd, 30)].filter((part) => part !== null).join(' · ');

export const RequestTable = ({ empty, heading, nowMs, records }: RequestTableProps) => (
  <>
    {heading === undefined ? null : <Heading>{heading}</Heading>}
    {records.length === 0 ? (
      empty === undefined ? null : <Agent.Text>{empty}</Agent.Text>
    ) : (
      <Table
        columns={['Ticket', 'Outcome', 'Command', 'Where', 'Age']}
        rows={records.map((record) => [
          record.ticket,
          outcome(record, nowMs),
          commandText(record),
          where(record),
          relativeTime(record.createdAtMs, nowMs),
        ])}
      />
    )}
  </>
);
