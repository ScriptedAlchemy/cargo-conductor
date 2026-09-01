import { incrementDenyCount, readDenyCount } from './hook-state.js';
import { listSessionPending, waitForTickets } from './rpc.js';
import type { FinishedTicket, PendingTicket } from './rpc.js';
import { resolveHookHost, type HookContext } from './shared.js';

export type { FinishedTicket, PendingTicket };

export interface StopHoldEvent {
  readonly sessionId?: string;
  readonly stopHookActive?: boolean;
}

export interface StopHoldResult {
  readonly additionalContext?: string;
  readonly outcome: 'continue' | 'deny';
  readonly reason?: string;
}

export interface StopHoldServices {
  readonly incrementDenyCount?: (ticket: string) => number;
  readonly listPending?: (session: string) => Promise<readonly PendingTicket[]>;
  readonly maxDenyCount?: number;
  readonly maxWaitMs?: number;
  readonly nowMs?: () => number;
  readonly readDenyCount?: (ticket: string) => number;
  readonly waitForTickets?: (
    tickets: readonly string[],
    maxWaitMs: number,
  ) => Promise<readonly FinishedTicket[]>;
}

const defaultMaxWaitMs = (() => {
  const parsed = Number.parseInt(process.env.CARGO_CONDUCTOR_STOP_WAIT_MS ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 30_000;
})();
const defaultMaxDenyCount = 8;

const remainingEtaMs = (ticket: PendingTicket, nowMs: number): number => {
  const estimate = ticket.estimateMs ?? 90_000;
  const started = ticket.startedAtMs ?? ticket.createdAtMs;
  return Math.max(1_000, estimate - Math.max(0, nowMs - started));
};

const formatFinished = (ticket: FinishedTicket): string => {
  switch (ticket.status) {
    case 'done':
      return `ticket ${ticket.ticket} finished: success, ${ticket.exitCode === 0 ? '0 errors' : `exit ${ticket.exitCode}`} — call conductor_result ${ticket.ticket}`;
    case 'failed':
      return `ticket ${ticket.ticket} finished: failed${ticket.error === null ? '' : ` (${ticket.error})`} — call conductor_result ${ticket.ticket}`;
    case 'killed':
      return `ticket ${ticket.ticket} finished: killed — call conductor_result ${ticket.ticket}`;
    default: {
      const exhaustive: never = ticket.status;
      return exhaustive;
    }
  }
};

const formatPending = (ticket: PendingTicket, nowMs: number): string => {
  const etaSeconds = Math.ceil(remainingEtaMs(ticket, nowMs) / 1000);
  return `${ticket.ticket} ${ticket.status}, ETA ${etaSeconds}s`;
};

const decideStopHold = async (
  event: StopHoldEvent,
  services: StopHoldServices,
): Promise<StopHoldResult> => {
  const session = event.sessionId;
  if (session === undefined || session.length === 0) {
    return { outcome: 'continue' };
  }

  const listPending = services.listPending ?? listSessionPending;
  let pending: readonly PendingTicket[];
  try {
    pending = (await listPending(session)).filter((ticket) => ticket.holdStop);
  } catch {
    return { outcome: 'continue' };
  }
  if (pending.length === 0) {
    return { outcome: 'continue' };
  }

  const maxDeny = services.maxDenyCount ?? defaultMaxDenyCount;
  const readDeny = services.readDenyCount ?? readDenyCount;
  if (event.stopHookActive === true) {
    const capped = pending.every((ticket) => readDeny(ticket.ticket) >= maxDeny);
    if (capped) {
      return { outcome: 'continue' };
    }
  }

  const nowMs = (services.nowMs ?? Date.now)();
  const maxWait = services.maxWaitMs ?? defaultMaxWaitMs;
  const waitMs = Math.min(maxWait, ...pending.map((ticket) => remainingEtaMs(ticket, nowMs)));
  const wait = services.waitForTickets ?? waitForTickets;
  let finished: readonly FinishedTicket[] = [];
  try {
    finished = await wait(
      pending.map((ticket) => ticket.ticket),
      waitMs,
    );
  } catch {
    finished = [];
  }

  if (finished.length > 0) {
    return {
      outcome: 'deny',
      reason: `${finished.map(formatFinished).join('; ')}; agent should restart holding these results`,
    };
  }

  const bump = services.incrementDenyCount ?? incrementDenyCount;
  for (const ticket of pending) {
    bump(ticket.ticket);
  }
  return {
    outcome: 'deny',
    reason: `results pending: ${pending.map((ticket) => formatPending(ticket, nowMs)).join('; ')}; stop again to keep waiting or call conductor_await`,
  };
};

/**
 * Bounded stop-hold: wait up to min(ETA, maxWaitMs), deny with the result if
 * anything finished, otherwise deny with status + ETA so the host re-enters.
 * `stopHookActive` plus a per-ticket deny cap is the livelock guard.
 */
export const handleStopHold = async (
  event: StopHoldEvent,
  services: StopHoldServices = {},
  _context: HookContext = {},
): Promise<StopHoldResult> => {
  try {
    return await decideStopHold(event, services);
  } catch {
    return { outcome: 'continue' };
  }
};

export default async (
  event: StopHoldEvent,
  context: HookContext = {},
): Promise<StopHoldResult> => {
  void resolveHookHost(context);
  return handleStopHold(event, {}, context);
};
