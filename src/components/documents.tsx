import { Agent } from '@agent-bundle/runtime';
import React from 'react';

import { awaitCeilingMs, orphanedByRestartError, type RequestRecord } from '../daemon/protocol.js';
import { formatMs } from '../lib/format.js';
import { documentValue } from '../lib/json.js';
import type {
  AwaitResult,
  KillResult,
  LastResult,
  LogResult,
  RequestSubmitResult,
  ResultFetchResult,
  StatusResult,
} from '../lib/protocol-schemas.js';
import { countWord } from '../lib/text.js';
import type { TicketOutputModel } from '../lib/ticket-output.js';

import { AdmissionState } from './admission-state.js';
import { DashboardLink } from './dashboard-link.js';
import { FullOutput } from './full-output.js';
import { KacheStats } from './kache-stats.js';
import { LaneBoard } from './lane-board.js';
import { DataList } from './primitives.js';
import { ErrorState, UnavailableState } from './states.js';
import type { SurfaceNames } from './surface.js';
import { TicketCard } from './ticket-card.js';
import { TicketGuidance } from './ticket-guidance.js';
import { TicketList } from './ticket-list.js';
import { lineageLine, type LineageModel } from './view-models.js';

/**
 * One document per hauler result, shared by the MCP tool and CLI routes so
 * both surfaces show the same cards, boards, tails, and next-step guidance;
 * only the command spellings in `names` differ.
 */
interface DocumentProps<Result> {
  readonly names: SurfaceNames;
  readonly nowMs: number;
  readonly result: Result;
}

const StoppedWithActive = ({ status }: { readonly status: StatusResult }) =>
  status.daemon === 'stopped' && status.active.length > 0 ? (
    <Agent.Context>
      {`${countWord(status.active.length, 'request')} show as active in the ledger but the daemon is stopped; they were interrupted and will not finish. The next daemon start marks them killed (${orphanedByRestartError}); resubmit the ones still wanted.`}
    </Agent.Context>
  ) : null;

export const StatusDocument = ({
  filtered,
  names,
  nowMs,
  result,
}: DocumentProps<StatusResult> & { readonly filtered: boolean }) => (
  <Agent.Result value={documentValue(result)}>
    <Agent.Text>{result.summary.split('\n', 1)[0] ?? result.summary}</Agent.Text>
    <AdmissionState status={result} />
    <LaneBoard active={result.active} lanes={result.lanes} nowMs={nowMs} />
    <TicketList
      empty={filtered ? 'No active requests match these filters.' : 'Nothing queued or running.'}
      heading="In flight"
      nowMs={nowMs}
      records={result.active}
    />
    <TicketList
      {...(filtered ? { empty: 'No recent requests match these filters.' } : {})}
      heading="Recent"
      nowMs={nowMs}
      records={result.recent}
    />
    <KacheStats kache={result.kache} />
    <StoppedWithActive status={result} />
    {result.active.length > 0 ? (
      <Agent.Context>
        {`Do not start a duplicate cargo run for anything listed in flight: submit through ${names.request} or run cargo normally and the hauler attaches you to the existing run. Wait with ${names.await} <ticket>.`}
      </Agent.Context>
    ) : null}
    <DashboardLink names={names} />
  </Agent.Result>
);

export const LogDocument = ({ nowMs, result }: DocumentProps<LogResult>) => (
  <Agent.Result value={documentValue(result)}>
    <Agent.Text>{result.summary}</Agent.Text>
    <TicketList empty="The ledger has no requests yet." nowMs={nowMs} records={result.requests} />
  </Agent.Result>
);

const TicketNotKnown = ({ names, ticket }: { readonly names: SurfaceNames; readonly ticket: string }) => (
  <UnavailableState what={ticket}>
    {`not known to the daemon. Tickets look like cc-123; check ${names.log} for recent ids.`}
  </UnavailableState>
);

const TicketDetail = ({
  names,
  nowMs,
  record,
}: {
  readonly names: SurfaceNames;
  readonly nowMs: number;
  readonly record: RequestRecord;
}) => (
  <>
    <TicketCard nowMs={nowMs} record={record} />
    <TicketGuidance names={names} record={record} />
  </>
);

export const LastDocument = ({ names, nowMs, result }: DocumentProps<LastResult>) => (
  <Agent.Result value={documentValue(result)}>
    <Agent.Text>{result.summary}</Agent.Text>
    {result.request === null ? null : <TicketDetail names={names} nowMs={nowMs} record={result.request} />}
  </Agent.Result>
);

export interface ResultDocumentProps extends DocumentProps<ResultFetchResult> {
  /** The ticket's on-disk full output log: a pointer by default, the log itself under `--full`. */
  readonly output: TicketOutputModel;
}

/**
 * `hauler result`: the ticket card with the stored tail, then where the whole
 * output lives. Under `--full` the log replaces the tail as the document body
 * (the tail would only repeat its last lines).
 */
export const ResultDocument = ({ names, nowMs, output, result }: ResultDocumentProps) => (
  <Agent.Result value={documentValue(result)}>
    <Agent.Text>{result.summary}</Agent.Text>
    {result.request === null ? (
      <TicketNotKnown names={names} ticket={result.ticket} />
    ) : (
      <>
        <TicketCard hideTail={output.kind === 'full'} nowMs={nowMs} record={result.request} />
        <FullOutput names={names} output={output} ticket={result.request.ticket} />
        <TicketGuidance names={names} record={result.request} />
      </>
    )}
  </Agent.Result>
);

export const KillDocument = ({ names, nowMs, result }: DocumentProps<KillResult>) => (
  <Agent.Result value={documentValue(result)}>
    <Agent.Text>{result.summary}</Agent.Text>
    {result.request === null ? null : <TicketCard nowMs={nowMs} record={result.request} />}
    <Agent.Context>
      {result.killed
        ? `Riders attached to ${result.ticket} return to their lane or fail with it. Confirm with ${names.result} ${result.ticket} (status becomes killed) and re-submit only if the work is still wanted.`
        : `Nothing changed. Use ${names.status} to find the ticket that is actually holding the lane.`}
    </Agent.Context>
  </Agent.Result>
);

export const AwaitDocument = ({
  maxWaitMs,
  names,
  nowMs,
  result,
}: DocumentProps<AwaitResult> & { readonly maxWaitMs: number }) => (
  <Agent.Result value={documentValue(result)}>
    <Agent.Text>{result.summary}</Agent.Text>
    {result.request === null ? null : <TicketCard nowMs={nowMs} record={result.request} />}
    {result.timedOut ? (
      <Agent.Context>
        {`The ${formatMs(maxWaitMs)} wait expired before ${result.ticket} finished. Call ${names.await} again (each call waits up to ${formatMs(awaitCeilingMs)}) rather than polling ${names.result} in a tight loop.`}
      </Agent.Context>
    ) : result.request === null ? (
      <TicketNotKnown names={names} ticket={result.ticket} />
    ) : (
      <TicketGuidance names={names} record={result.request} />
    )}
  </Agent.Result>
);

export interface RequestDocumentProps extends Omit<DocumentProps<RequestSubmitResult>, 'nowMs'> {
  readonly argv: readonly string[];
  readonly lineage: LineageModel | null;
}

/** `behind cc-3281 (2 ahead, wait ~13m)`, or null when the lane was idle or the request attached. */
const requestQueueText = (result: RequestSubmitResult): string | null => {
  const queue = result.queue;
  if (queue === undefined || queue.ahead.length === 0) {
    return null;
  }
  const wait = queue.waitEtaMs === undefined ? '' : `, wait ~${formatMs(queue.waitEtaMs)}`;
  return `behind ${queue.ahead.join(', ')} (${queue.position} ahead${wait})`;
};

export const RequestDocument = ({ argv, lineage, names, result }: RequestDocumentProps) => (
  <Agent.Result value={documentValue(result)}>
    <Agent.Text>{result.summary}</Agent.Text>
    {result.ticket === null ? (
      <ErrorState code="submit-failed">
        {`The daemon did not accept ${argv.join(' ')}; run hauler daemon status or check the daemon log.`}
      </ErrorState>
    ) : (
      <>
        <DataList
          fields={[
            { label: 'Ticket', value: result.ticket },
            { label: 'Attributed to', value: `${result.attribution.host}${result.attribution.session === null ? '' : ` / ${result.attribution.session}`}` },
            { label: 'Lineage', value: lineage === null ? null : lineageLine(lineage) },
            { label: 'Queue', value: requestQueueText(result) },
            {
              label: 'Waits for',
              value: result.waitingFor === undefined || result.waitingFor.length === 0 ? null : result.waitingFor.join(', '),
            },
          ]}
        />
        <Agent.Context>
          {result.waitingFor === undefined || result.waitingFor.length === 0
            ? `Ticket ${result.ticket} is running in the background. Continue other work; when the session has a hold-stop ticket the stop hook waits for it. Retrieve with ${names.result} ${result.ticket}, or block with ${names.await} ${result.ticket}.`
            : `Ticket ${result.ticket} is queued behind ${result.waitingFor.join(', ')} and starts once they finish; it fails with "prerequisite cc-N failed" if one of them fails or is killed. Retrieve with ${names.result} ${result.ticket}, or block with ${names.await} ${result.ticket}.`}
        </Agent.Context>
      </>
    )}
  </Agent.Result>
);
