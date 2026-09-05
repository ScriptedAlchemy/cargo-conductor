import * as Effect from 'effect/Effect';

import { fetchTicket } from '../client/tickets.js';
import type { DaemonConfigShape } from '../daemon/config.js';
import type { RequestRecord } from '../daemon/protocol.js';
import { displayRequestRecord, displayStatusRows, loadHaulerSnapshot, loadLedgerRequest } from '../query.js';

import type {
  LastResult,
  LimitInput,
  LogResult,
  StatusInput,
  StatusResult,
} from './protocol-schemas.js';
import { filterStatusRows, hasStatusFilters, statusSummary } from './status-filter.js';
import { runTicketEffect } from './ticket-errors.js';

export interface InspectOptions {
  readonly config?: DaemonConfigShape;
  readonly signal: AbortSignal;
}

// Through the ticket boundary runner so MCP/CLI cancellation aborts the
// socket wait; the snapshot itself never fails.
const loadSnapshot = (limit: number, options: InspectOptions) =>
  runTicketEffect(
    loadHaulerSnapshot({
      recentLimit: limit,
      ...(options.config === undefined ? {} : { config: options.config }),
    }),
    options.signal,
  );

/**
 * `hauler last`: the newest ticket named by the status listing, read as a
 * detail record — the listing's rows carry no tail (#95), so the record comes
 * from the daemon's `result` (the live tail overlaid while it runs) or, with
 * no daemon answering, from the ledger. Like status, the read fails open: a
 * daemon that stops answering between the two calls yields the ledger record.
 */
export const loadLastResult = async (options: InspectOptions): Promise<LastResult> => {
  const snapshot = await loadSnapshot(1, options);
  const latest = snapshot.recent[0] ?? null;
  const detailOf = (ticket: string): Effect.Effect<RequestRecord | null> => {
    const fromLedger = loadLedgerRequest(ticket, options.config);
    return snapshot.daemon === 'running'
      ? fetchTicket(ticket, options.config).pipe(Effect.catch(() => fromLedger))
      : fromLedger;
  };
  const request = latest === null ? null : await runTicketEffect(detailOf(latest.ticket), options.signal);
  return {
    daemon: snapshot.daemon,
    operation: 'last',
    request: request === null ? null : displayRequestRecord(request),
    summary:
      request === null
        ? latest === null
          ? 'no hauler requests recorded'
          : `${latest.ticket} is no longer recorded`
        : `${request.ticket} ${request.status}`,
  };
};

export const loadLogResult = async (
  input: LimitInput,
  options: InspectOptions,
): Promise<LogResult> => {
  const snapshot = await loadSnapshot(input.limit ?? 50, options);
  return {
    daemon: snapshot.daemon,
    operation: 'log',
    requests: displayStatusRows(snapshot.recent),
    summary:
      snapshot.recent.length === 0
        ? 'no hauler requests recorded'
        : `${snapshot.recent.length} recent request${snapshot.recent.length === 1 ? '' : 's'}`,
  };
};

/**
 * Filtered reads fetch a deep window (500) before filtering so a busy ledger
 * still answers "show me my session" instead of the newest N rows overall.
 * Rows are the bounded status contract: no tail, a short `outputPreview` on
 * running rows; `result` reads a ticket's whole tail (#95).
 */
export const loadStatusResult = async (
  input: StatusInput,
  options: InspectOptions,
): Promise<StatusResult> => {
  const limit = input.limit ?? 20;
  const snapshot = await loadSnapshot(hasStatusFilters(input) ? 500 : limit, options);
  const active = filterStatusRows(snapshot.active, input);
  const recent = filterStatusRows(snapshot.recent, input).slice(0, limit);
  return {
    ...snapshot,
    active: displayStatusRows(active),
    operation: 'status',
    recent: displayStatusRows(recent),
    summary: statusSummary(snapshot.daemon, active, recent),
  };
};
