import { finishedTicketsOf, type FinishedTicket } from '../finished-ticket.js';
import { resolveHookSocketPath } from '../paths.js';
import { requestOutcome } from '../rpc.js';

/**
 * The bounded wait `after-shell.ts` has always given the `session-completed`
 * request: long enough for a daemon busy fanning out builds, short enough
 * that a stuck socket cannot hold a tool call.
 */
export const defaultPingTimeoutMs = 500;

/**
 * What one session-completion ping learned. `finished` is the daemon's
 * answer (possibly empty). `unavailable` is every way the answer did not
 * arrive: nothing listening (`unreachable`, with the errno so a caller can
 * tell `ECONNREFUSED` / `ENOENT` from the rest), no reply within the budget
 * (`timeout`), the daemon hanging up first (`closed`), or a reply that is not
 * a `session-completed-result` (`malformed`).
 */
export type SessionCompletedPing =
  | { readonly kind: 'finished'; readonly tickets: readonly FinishedTicket[] }
  | { readonly kind: 'unavailable'; readonly reason: 'closed' | 'malformed' | 'timeout' }
  | { readonly kind: 'unavailable'; readonly reason: 'unreachable'; readonly code: string | null };

export interface SessionPingOptions {
  readonly socketPath?: string;
  readonly timeoutMs?: number;
}

/**
 * The smallest client of the daemon's `session-completed` request: one
 * `net.connect` on the Unix socket, one NDJSON line out, the first line back
 * (`requestOutcome`, which is dependency-free — no Effect runtime, no shared
 * `LineBuffer`). The hook fast path runs this on every after-tool call before
 * deciding whether the rest of the hook needs to load at all. It never throws
 * and never writes to stdout or stderr: a daemon that is down or slow is an
 * `unavailable` value, not an error.
 *
 * The wire shape is exactly the one `listSessionCompleted` in `rpc.ts`
 * sends: one client on the wire, whichever entry point built the message.
 */
export const pingSessionCompleted = async (
  session: string,
  sinceMs: number,
  options: SessionPingOptions = {},
): Promise<SessionCompletedPing> => {
  const outcome = await requestOutcome(
    { id: 'hook-completed', session, sinceMs, type: 'session-completed' },
    options.socketPath ?? resolveHookSocketPath(),
    options.timeoutMs ?? defaultPingTimeoutMs,
  );
  switch (outcome.kind) {
    case 'reply': {
      const tickets = finishedTicketsOf(outcome.message);
      return tickets === null ? { kind: 'unavailable', reason: 'malformed' } : { kind: 'finished', tickets };
    }
    case 'closed':
    case 'malformed':
    case 'timeout':
      return { kind: 'unavailable', reason: outcome.kind };
    case 'replacement-failed':
      return { kind: 'unavailable', reason: 'malformed' };
    case 'unreachable':
      return { code: outcome.code ?? null, kind: 'unavailable', reason: 'unreachable' };
    default: {
      const exhaustive: never = outcome;
      return exhaustive;
    }
  }
};
