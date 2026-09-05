import { awaitCeilingMs } from '../daemon/protocol.js';

import { incrementDenyCount, pruneDenyCounts, readDenyCount } from './hook-state.js';
import { listSessionPending, waitForTickets } from './rpc.js';
import type { FinishedTicket, PendingTicket } from './rpc.js';
import { formatFinishedTicket, type HookContext } from './shared.js';

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
  readonly incrementDenyCount?: (ticket: string, session: string) => number;
  readonly listPending?: (session: string) => Promise<readonly PendingTicket[]>;
  readonly maxDenyCount?: number;
  readonly maxWaitMs?: number;
  readonly nowMs?: () => number;
  readonly pruneDenyCounts?: (session: string, keep: readonly string[]) => void;
  readonly readDenyCount?: (ticket: string) => number;
  readonly waitForTickets?: (
    tickets: readonly string[],
    maxWaitMs: number,
  ) => Promise<readonly FinishedTicket[]>;
}

// 30s per hold is deliberately far below the 900s stop-hook budget: Codex's
// per-hook timeout honoring is unverified, and the re-deny loop already makes
// the total wait unbounded. Raise via CARGO_HAULER_STOP_WAIT_MS on hosts
// known to honor long hook timeouts; values above the daemon's await ceiling
// are clamped, since the wire schema rejects a larger `maxWaitMs` outright
// and every ticket would then read as unfinished.
const defaultMaxWaitMs = (() => {
  const parsed = Number.parseInt(process.env.CARGO_HAULER_STOP_WAIT_MS ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, awaitCeilingMs) : 30_000;
})();
const defaultMaxDenyCount = 8;

const remainingEtaMs = (ticket: PendingTicket, nowMs: number): number => {
  const estimate = ticket.estimateMs ?? 90_000;
  const started = ticket.startedAtMs ?? ticket.createdAtMs;
  return Math.max(1_000, estimate - Math.max(0, nowMs - started));
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
  const prune = services.pruneDenyCounts ?? pruneDenyCounts;
  if (pending.length === 0) {
    prune(session, []);
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
  const maxWait = Math.min(services.maxWaitMs ?? defaultMaxWaitMs, awaitCeilingMs);
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

  const finishedTickets = new Set(finished.map((ticket) => ticket.ticket));
  prune(
    session,
    pending.flatMap((ticket) => (finishedTickets.has(ticket.ticket) ? [] : [ticket.ticket])),
  );

  if (finished.length > 0) {
    return {
      outcome: 'deny',
      reason: `${finished.map(formatFinishedTicket).join('; ')}; agent should restart holding these results`,
    };
  }

  const bump = services.incrementDenyCount ?? incrementDenyCount;
  for (const ticket of pending) {
    bump(ticket.ticket, session);
  }
  return {
    outcome: 'deny',
    reason: `results pending: ${pending.map((ticket) => formatPending(ticket, nowMs)).join('; ')}; stop again to keep waiting or call hauler_await`,
  };
};

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

export default (event: StopHoldEvent, context: HookContext = {}): Promise<StopHoldResult> =>
  handleStopHold(event, {}, context);
