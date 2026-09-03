import { Agent } from '@agent-bundle/runtime';
import React from 'react';

import { formatMs } from '../lib/format.js';
import { documentValue } from '../lib/json.js';
import type {
  AwaitResult,
  LastResult,
  LogResult,
  RequestSubmitResult,
  ResultFetchResult,
  StatusResult,
} from '../lib/protocol-schemas.js';

import { RequestTable } from './request-table.js';
import { StatusOverview } from './status-overview.js';
import type { SurfaceNames } from './surface.js';
import { TicketCard, TicketGuidance } from './ticket-card.js';

/**
 * One document per hauler result, shared by the MCP tool and CLI routes so
 * both surfaces show the same tables, tails, and next-step guidance; only
 * the command spellings in `names` differ.
 */
interface DocumentProps<Result> {
  readonly names: SurfaceNames;
  readonly nowMs: number;
  readonly result: Result;
}

export const StatusDocument = ({
  filtered,
  names,
  nowMs,
  result,
}: DocumentProps<StatusResult> & { readonly filtered: boolean }) => (
  <Agent.Result value={documentValue(result)}>
    <Agent.Text>{result.summary.split('\n', 1)[0] ?? result.summary}</Agent.Text>
    <StatusOverview nowMs={nowMs} status={result} />
    <RequestTable
      empty={filtered ? 'No active requests match these filters.' : 'Nothing queued or running.'}
      heading="In flight"
      nowMs={nowMs}
      records={result.active}
    />
    <RequestTable
      empty={filtered ? 'No recent requests match these filters.' : undefined}
      heading="Recent"
      nowMs={nowMs}
      records={result.recent}
    />
    {result.active.length > 0 ? (
      <Agent.Context>
        {`Do not start a duplicate cargo run for anything listed in flight: submit through ${names.request} or run cargo normally and the hauler attaches you to the existing run. Wait with ${names.await} <ticket>.`}
      </Agent.Context>
    ) : null}
  </Agent.Result>
);

export const LogDocument = ({ nowMs, result }: DocumentProps<LogResult>) => (
  <Agent.Result value={documentValue(result)}>
    <Agent.Text>{result.summary}</Agent.Text>
    <RequestTable nowMs={nowMs} records={result.requests} />
  </Agent.Result>
);

export const LastDocument = ({ names, nowMs, result }: DocumentProps<LastResult>) => (
  <Agent.Result value={documentValue(result)}>
    <Agent.Text>{result.summary}</Agent.Text>
    {result.request === null ? null : (
      <>
        <TicketCard nowMs={nowMs} record={result.request} />
        <TicketGuidance names={names} record={result.request} />
      </>
    )}
  </Agent.Result>
);

export const ResultDocument = ({ names, nowMs, result }: DocumentProps<ResultFetchResult>) => (
  <Agent.Result value={documentValue(result)}>
    <Agent.Text>{result.summary}</Agent.Text>
    {result.request === null ? (
      <Agent.Context>
        {`${result.ticket} is not known to the daemon. Tickets look like cc-123; check ${names.log} for recent ids.`}
      </Agent.Context>
    ) : (
      <>
        <TicketCard nowMs={nowMs} record={result.request} />
        <TicketGuidance names={names} record={result.request} />
      </>
    )}
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
        {`The ${formatMs(maxWaitMs)} wait expired before ${result.ticket} finished. Call ${names.await} again with a larger wait (up to 7200000 ms) rather than polling ${names.result} in a tight loop.`}
      </Agent.Context>
    ) : result.request === null ? (
      <Agent.Context>{`${result.ticket} is not known to the daemon; check ${names.log} for recent ticket ids.`}</Agent.Context>
    ) : (
      <TicketGuidance names={names} record={result.request} />
    )}
  </Agent.Result>
);

export const RequestDocument = ({
  argv,
  names,
  result,
}: Omit<DocumentProps<RequestSubmitResult>, 'nowMs'> & { readonly argv: readonly string[] }) => (
  <Agent.Result value={documentValue(result)}>
    <Agent.Text>{result.summary}</Agent.Text>
    {result.ticket === null ? (
      <Agent.Error code="submit-failed">
        {`The daemon did not accept ${argv.join(' ')}; run hauler daemon status or check the daemon log.`}
      </Agent.Error>
    ) : (
      <Agent.Context>
        {`Ticket ${result.ticket} is running in the background. Continue other work; when the session has a hold-stop ticket the stop hook waits for it. Retrieve with ${names.result} ${result.ticket}, or block with ${names.await} ${result.ticket}.`}
      </Agent.Context>
    )}
  </Agent.Result>
);
