import type { TicketSummary } from '../daemon/protocol.js';
import { commandDisplay, formatMs } from '../lib/format.js';
import { countWord } from '../lib/text.js';

export const commandText = (record: Pick<TicketSummary, 'argv'>): string => commandDisplay(record.argv);

export const elapsedMs = (record: TicketSummary, nowMs: number): number | null => {
  switch (record.status) {
    case 'queued':
    case 'requested':
      return Math.max(0, nowMs - (record.queuedAtMs ?? record.createdAtMs));
    case 'running':
      return record.startedAtMs === null ? null : Math.max(0, nowMs - record.startedAtMs);
    case 'done':
    case 'failed':
    case 'killed':
    case 'denied':
    case 'passthrough':
      return record.runMs;
    default: {
      const exhaustive: never = record.status;
      return exhaustive;
    }
  }
};

export const diagnosticCounts = (
  record: Pick<TicketSummary, 'errorCount' | 'warningCount'>,
): string | null =>
  record.errorCount === null || record.warningCount === null
    ? null
    : `${countWord(record.errorCount, 'error')}, ${countWord(record.warningCount, 'warning')}`;

export const ticketHeadline = (record: TicketSummary, nowMs: number): string => {
  const elapsed = elapsedMs(record, nowMs);
  const timing = elapsed === null ? '' : ` ${formatMs(elapsed)}`;
  const estimate =
    (record.status === 'queued' || record.status === 'running') && record.estimateMs !== null
      ? ` (est ~${formatMs(record.estimateMs)})`
      : '';
  const exit =
    record.exitCode === null || record.status === 'done' ? '' : ` exit=${record.exitCode}`;
  const counts = diagnosticCounts(record);
  const outcome = counts === null ? '' : ` — ${counts}`;
  const stalled =
    record.status === 'running' && record.stall !== undefined
      ? ` · stalled ${formatMs(record.stall.idleMs)}`
      : '';
  return `${record.ticket} ${record.status}${timing}${estimate}${stalled}${exit}${outcome} — ${commandText(record)}`;
};

export const requestCountHeadline = (count: number, noun: string): string =>
  count === 0 ? `no ${noun}s recorded` : countWord(count, noun);
