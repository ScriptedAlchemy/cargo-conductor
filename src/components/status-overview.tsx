import { Agent } from '@agent-bundle/runtime';
import React from 'react';

import type { StatusResult } from '../lib/protocol-schemas.js';
import { formatBytes, formatMs, pathBasename, relativeTime } from '../lib/format.js';
import { countWord } from '../lib/text.js';

import { DataList, Table } from './primitives.js';

export interface StatusOverviewProps {
  readonly nowMs: number;
  readonly status: StatusResult;
}

const loadText = (status: StatusResult): string | null => {
  const system = status.system;
  if (system === undefined) {
    return null;
  }
  const load = `load ${system.loadAvg1.toFixed(1)} on ${system.cores} cores`;
  const io = system.ioWaitPercent === undefined ? '' : `, iowait ${system.ioWaitPercent.toFixed(0)}%`;
  const memory =
    system.memClamp === undefined || system.memClamp === 'none'
      ? system.memAvailableBytes === undefined
        ? ''
        : `, ${formatBytes(system.memAvailableBytes)} available`
      : `, memory pressure ${system.memClamp} (admission ${system.memClamp === 'hard' ? 'paused' : 'reduced'})`;
  return `${load}${io}${memory}`;
};

const savingsText = (status: StatusResult): string | null => {
  const totals = status.savings?.totals;
  if (totals === undefined || totals.ridersServed === 0) {
    return null;
  }
  return `${countWord(totals.ridersServed, 'request')} attached to in-flight runs, ~${formatMs(totals.savedComputeMs)} of compute avoided`;
};

const kacheText = (status: StatusResult): string | null => {
  const kache = status.kache;
  if (kache === undefined || kache === null) {
    return null;
  }
  if (!kache.available) {
    return 'not detected (cost priors fall back to ledger history)';
  }
  const fresh = kache.eventsFreshMs === null ? '' : `, events ${formatMs(kache.eventsFreshMs)} old`;
  return `${countWord(kache.entryCount, 'entry')} across ${countWord(kache.distinctCrates, 'crate')} (${formatBytes(kache.indexSizeBytes)})${fresh}`;
};

export const StatusOverview = ({ nowMs, status }: StatusOverviewProps) => {
  const running = status.active.filter((record) => record.status === 'running');
  const queued = status.active.filter((record) => record.status === 'queued');
  const admission =
    status.maxConcurrent === null
      ? null
      : `${running.length} running of ${status.maxConcurrent} permits, ${queued.length} queued`;
  const busyLanes = status.lanes.filter((lane) => lane.queued > 0 || lane.runningTicket !== null);
  return (
    <>
      <DataList
        fields={[
          {
            label: 'Daemon',
            value:
              status.daemon === 'running'
                ? `running (pid ${status.pid ?? '?'}${status.startedAtMs === null ? '' : `, up since ${relativeTime(status.startedAtMs, nowMs)}`})`
                : 'stopped — showing ledger history; it starts on demand with the next cargo request',
          },
          { label: 'Admission', value: admission },
          { label: 'System', value: loadText(status) },
          { label: 'Sharing', value: savingsText(status) },
          { label: 'kache', value: kacheText(status) },
          { label: 'State', value: status.stateRoot },
        ]}
      />
      {busyLanes.length === 0 ? null : (
        <Table
          columns={['Lane', 'Running', 'Queued']}
          rows={busyLanes.map((lane) => [
            `${pathBasename(lane.workspaceRoot)} (${pathBasename(lane.targetDir)})`,
            lane.runningTicket ?? '—',
            String(lane.queued),
          ])}
        />
      )}
      {status.daemon === 'stopped' && status.active.length > 0 ? (
        <Agent.Context>
          {`${countWord(status.active.length, 'request')} show as active in the ledger but the daemon is stopped; they were interrupted and will not finish.`}
        </Agent.Context>
      ) : null}
    </>
  );
};
