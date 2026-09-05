import type { DaemonConfigShape } from '../daemon/config.js';
import { displayRequestRecord, displayRequestRecords, loadHaulerSnapshot } from '../query.js';

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

export const loadLastResult = async (options: InspectOptions): Promise<LastResult> => {
  const snapshot = await loadSnapshot(1, options);
  const request = snapshot.recent[0] ?? null;
  return {
    daemon: snapshot.daemon,
    operation: 'last',
    request: request === null ? null : displayRequestRecord(request),
    summary: request === null ? 'no hauler requests recorded' : `${request.ticket} ${request.status}`,
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
    requests: displayRequestRecords(snapshot.recent),
    summary:
      snapshot.recent.length === 0
        ? 'no hauler requests recorded'
        : `${snapshot.recent.length} recent request${snapshot.recent.length === 1 ? '' : 's'}`,
  };
};

/**
 * Filtered reads fetch a deep window (500) before filtering so a busy ledger
 * still answers "show me my session" instead of the newest N rows overall.
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
    active: displayRequestRecords(active),
    operation: 'status',
    recent: displayRequestRecords(recent),
    summary: statusSummary(snapshot.daemon, active, recent),
  };
};
