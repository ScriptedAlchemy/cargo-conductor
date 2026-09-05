import { isRecord } from '../lib/guards.js';

/**
 * One finished ticket as the daemon's `session-completed-result` lists it,
 * shared by the hook fast path (`src/hooks/fast-path/session-ping.ts`) and
 * the full client in `rpc.ts`, so both read the daemon's reply the same way.
 */
export interface FinishedTicket {
  readonly error: string | null;
  readonly errorCount: number | null;
  readonly exitCode: number | null;
  readonly status: 'done' | 'failed' | 'killed';
  readonly ticket: string;
  readonly warningCount: number | null;
}

/** One `requests[]` entry of a `session-completed-result`; null for anything that is not a finished ticket. */
export const asFinishedTicket = (value: unknown): FinishedTicket | null => {
  if (!isRecord(value) || typeof value.ticket !== 'string') {
    return null;
  }
  const status = value.status;
  if (status !== 'done' && status !== 'failed' && status !== 'killed') {
    return null;
  }
  return {
    error: typeof value.error === 'string' ? value.error : null,
    errorCount: typeof value.errorCount === 'number' ? value.errorCount : null,
    exitCode: typeof value.exitCode === 'number' ? value.exitCode : null,
    status,
    ticket: value.ticket,
    warningCount: typeof value.warningCount === 'number' ? value.warningCount : null,
  };
};

/** The finished tickets of a `session-completed-result` reply, or null when the reply is not one. */
export const finishedTicketsOf = (reply: Readonly<Record<string, unknown>>): readonly FinishedTicket[] | null => {
  if (reply.type !== 'session-completed-result' || !Array.isArray(reply.requests)) {
    return null;
  }
  return reply.requests.flatMap((entry: unknown) => {
    const parsed = asFinishedTicket(entry);
    return parsed === null ? [] : [parsed];
  });
};
