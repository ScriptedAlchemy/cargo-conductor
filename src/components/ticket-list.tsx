import React from 'react';

import type { RequestRecord } from '../daemon/protocol.js';
import { formatMs, relativeTime, shortenPath } from '../lib/format.js';

import { commandText, elapsedMs } from './headlines.js';
import { Heading, Table } from './primitives.js';
import { EmptyState } from './states.js';

export interface TicketListProps {
  readonly empty?: string;
  readonly heading?: string;
  readonly nowMs: number;
  readonly records: readonly RequestRecord[];
}

const outcome = (record: RequestRecord, nowMs: number): string => {
  const elapsed = elapsedMs(record, nowMs);
  const timing = elapsed === null ? '' : ` ${formatMs(elapsed)}`;
  switch (record.status) {
    case 'queued':
      return record.queue === undefined ? `queued${timing}` : `queued${timing} · ${record.queue.position} ahead`;
    case 'running': {
      const estimate = record.estimateMs === null ? '' : ` / ~${formatMs(record.estimateMs)}`;
      const stalled = record.stall === undefined ? '' : ` · stalled ${formatMs(record.stall.idleMs)}`;
      return `running${timing}${estimate}${stalled}`;
    }
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

/** A table of tickets — the in-flight and recent sections of status, and the whole of log. */
export const TicketList = ({ empty, heading, nowMs, records }: TicketListProps) => (
  <>
    {heading === undefined ? null : <Heading>{heading}</Heading>}
    {records.length === 0 ? (
      empty === undefined ? null : <EmptyState>{empty}</EmptyState>
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
