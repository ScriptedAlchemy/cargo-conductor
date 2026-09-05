import React from 'react';

import type { LaneStatus, RequestRecord } from '../daemon/protocol.js';
import { countWord } from '../lib/text.js';

import { Heading, Table } from './primitives.js';
import { EmptyState } from './states.js';
import { laneBoardModel } from './view-models.js';

export interface LaneBoardProps {
  readonly active: readonly RequestRecord[];
  readonly lanes: readonly LaneStatus[];
  readonly nowMs: number;
}

/**
 * Work grouped by resolved (workspace root, target dir). Only lanes with
 * queued or running work get a row; idle lanes are counted, never listed.
 */
export const LaneBoard = ({ active, lanes, nowMs }: LaneBoardProps) => {
  const model = laneBoardModel(lanes, active, nowMs);
  if (model.rows.length === 0) {
    return lanes.length === 0
      ? null
      : <EmptyState>{`${countWord(lanes.length, 'lane')} known, none busy.`}</EmptyState>;
  }
  return (
    <>
      <Heading>Lanes</Heading>
      <Table
        columns={['Lane', 'Running', 'For', 'Command', 'Queued', 'Executing']}
        rows={model.rows.map((row) => [
          row.name,
          row.running,
          row.runningFor === null ? '—' : `${row.runningFor}${row.stalled === null ? '' : ` · ${row.stalled}`}`,
          row.runningCommand ?? '—',
          String(row.queued),
          row.executing ?? '—',
        ])}
      />
    </>
  );
};
