import { Agent } from '@agent-bundle/runtime';
import React from 'react';

import type { RequestRecord } from '../daemon/protocol.js';
import { formatMs, relativeTime, shortenPath } from '../lib/format.js';

import { commandText, diagnosticCounts, ticketHeadline } from './headlines.js';
import { CodeBlock, DataList, Heading } from './primitives.js';
import type { SurfaceNames } from './surface.js';

export interface TicketCardProps {
  readonly nowMs: number;
  readonly record: RequestRecord;
  readonly tailLines?: number;
}

const attachText = (record: RequestRecord): string | null => {
  if (record.attachedTo === null) {
    return null;
  }
  const mode = record.attachMode === null ? '' : ` (${record.attachMode})`;
  const saved =
    record.savedComputeMs === null || record.savedComputeMs === undefined
      ? ''
      : `, saved ~${formatMs(record.savedComputeMs)} of compute`;
  return `rode ${record.attachedTo}${mode}${saved}`;
};

const queueText = (record: RequestRecord): string | null => {
  const queue = record.queue;
  if (record.status !== 'queued' || queue === undefined) {
    return null;
  }
  const head =
    queue.headTicket === undefined
      ? ''
      : ` behind ${queue.headTicket}${
          queue.headElapsedMs === undefined ? '' : ` (running ${formatMs(queue.headElapsedMs)})`
        }`;
  const delayed = record.delayed === true ? '; wait exceeds estimate — lane busy' : '';
  return `${queue.position} ahead${head}, wait ~${formatMs(queue.waitEtaMs)}${delayed}`;
};

const lastLines = (text: string, limit: number): string => {
  const lines = text.replace(/\n$/u, '').split('\n');
  return lines.length <= limit ? lines.join('\n') : `… (${lines.length - limit} earlier lines omitted)\n${lines.slice(-limit).join('\n')}`;
};

export const TicketCard = ({ nowMs, record, tailLines = 40 }: TicketCardProps) => {
  const where = [record.host, record.session].filter((part) => part !== null).join(' / ');
  const quiet =
    record.status === 'running' && record.quietMs !== undefined && record.quietMs >= 60_000
      ? `no output for ${formatMs(record.quietMs)}`
      : null;
  return (
    <>
      <Heading>{ticketHeadline(record, nowMs)}</Heading>
      <DataList
        fields={[
          { label: 'Command', value: commandText(record) },
          { label: 'Ran as', value: ranAs(record) },
          { label: 'Where', value: `${shortenPath(record.cwd)}${where === '' ? '' : ` · ${where}`}` },
          { label: 'Lane', value: record.laneKey },
          { label: 'Queue', value: queueText(record) },
          { label: 'Attached', value: attachText(record) },
          { label: 'Waited', value: record.waitMs === null ? null : formatMs(record.waitMs) },
          { label: 'Started', value: record.startedAtMs === null ? null : relativeTime(record.startedAtMs, nowMs) },
          { label: 'Finished', value: record.finishedAtMs === null ? null : relativeTime(record.finishedAtMs, nowMs) },
          { label: 'Exit', value: record.exitCode === null ? record.signal : `${record.exitCode}${record.signal === null ? '' : ` (${record.signal})`}` },
          { label: 'Diagnostics', value: diagnosticCounts(record) },
          { label: 'Output', value: quiet },
          { label: 'Error', value: record.error },
        ]}
      />
      {record.diagnostics !== null && record.diagnostics.length > 0 ? (
        <CodeBlock lang="text">{record.diagnostics.join('')}</CodeBlock>
      ) : null}
      {record.outputTail !== null && record.outputTail.trim() !== '' ? (
        <>
          <Agent.Text>{record.outputTailLive === true ? 'Live output tail:' : 'Output tail:'}</Agent.Text>
          <CodeBlock lang="text">{lastLines(record.outputTail, tailLines)}</CodeBlock>
        </>
      ) : null}
    </>
  );
};

const ranAs = (record: RequestRecord): string | null => {
  if (record.execArgv === null) {
    return null;
  }
  const cleaned = record.execArgv.filter((part) => !part.startsWith('--message-format='));
  const same = cleaned.length === record.argv.length && cleaned.every((part, index) => part === record.argv[index]);
  return same ? null : cleaned.join(' ');
};

export const TicketGuidance = ({
  names,
  record,
}: {
  readonly names: SurfaceNames;
  readonly record: RequestRecord;
}) => {
  switch (record.status) {
    case 'requested':
    case 'queued':
    case 'running':
      return (
        <Agent.Context>
          {`${record.ticket} is still ${record.status}. Do not re-run the same cargo command; call ${names.await} with ticket ${record.ticket} (up to two hours) or check ${names.result} later.`}
        </Agent.Context>
      );
    case 'done':
      return <Agent.Context>{`${record.ticket} succeeded; its output above is the result of that cargo run.`}</Agent.Context>;
    case 'failed':
      return (
        <Agent.Context>
          {`${record.ticket} failed (exit ${record.exitCode ?? 'unknown'}). Fix the diagnostics above before re-running; the hauler dedupes identical requests, so an unchanged retry attaches to the same result.`}
        </Agent.Context>
      );
    case 'killed':
      return <Agent.Context>{`${record.ticket} was killed before finishing; resubmit only if the work is still needed.`}</Agent.Context>;
    case 'denied':
      return <Agent.Context>{`${record.ticket} was denied by a hook: ${record.error ?? 'see error above'}.`}</Agent.Context>;
    case 'passthrough':
      return <Agent.Context>{`${record.ticket} ran directly without broker coordination.`}</Agent.Context>;
    default: {
      const exhaustive: never = record.status;
      return exhaustive;
    }
  }
};
