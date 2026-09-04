import React from 'react';

import type { RequestRecord } from '../daemon/protocol.js';

import { BuildDiagnostics } from './build-diagnostics.js';
import { ticketHeadline } from './headlines.js';
import { LogTail } from './log-tail.js';
import { DataList, Heading } from './primitives.js';
import { ticketCardModel } from './view-models.js';

export interface TicketCardProps {
  /** Leave the output tail out (the caller renders the full log instead). */
  readonly hideTail?: boolean;
  readonly nowMs: number;
  readonly record: RequestRecord;
  readonly tailLines?: number;
}

/**
 * One ticket, fully: headline, attribution and placement, structured
 * diagnostics, and the output tail (live while the run is in progress).
 * `hauler_result`, `hauler_last`, and `hauler_await` all render this card, so
 * a ticket reads identically wherever an agent meets it.
 */
export const TicketCard = ({ hideTail = false, nowMs, record, tailLines }: TicketCardProps) => {
  const model = ticketCardModel(record, nowMs);
  return (
    <>
      <Heading>{ticketHeadline(record, nowMs)}</Heading>
      <DataList
        fields={[
          { label: 'Command', value: model.command },
          { label: 'Ran as', value: model.ranAs },
          { label: 'Where', value: model.where },
          { label: 'Lane', value: model.lane },
          { label: 'Queue', value: model.queue },
          { label: 'After', value: model.after },
          { label: 'Attached', value: model.attached },
          { label: 'Waited', value: model.waited },
          { label: 'Started', value: model.started },
          { label: 'Finished', value: model.finished },
          { label: 'Exit', value: model.exit },
          { label: 'Diagnostics', value: model.diagnosticsSummary },
          { label: 'Output', value: model.quiet },
          { label: 'Stalled', value: model.stalled },
          { label: 'Error', value: model.error },
        ]}
      />
      <BuildDiagnostics record={record} />
      {hideTail ? null : (
        <LogTail live={record.outputTailLive === true} text={record.outputTail} {...(tailLines === undefined ? {} : { maxLines: tailLines })} />
      )}
    </>
  );
};
