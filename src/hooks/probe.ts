import { absentSocketCodes } from '../lib/socket-errors.js';

import { resolveHookSocketPath } from './paths.js';
import { requestOutcome, type RequestOutcome } from './rpc.js';
import { isRecord } from './shared.js';

const defaultTimeoutMs = 250;

/**
 * What the `cargo clean` guard learned about the daemon.
 *
 * - `active`: queued or running work; a raw clean would race it.
 * - `idle`: answered, nothing in flight.
 * - `busy`: alive but did not answer within the probe budget (or answered
 *   with something other than a status report). A saturated daemon is exactly
 *   when its lanes are fanning builds into the target directory.
 * - `absent`: nothing listens on the socket.
 */
export type DaemonProbe = 'absent' | 'active' | 'busy' | 'idle';

/** `ENOTSOCK` joins the shared set here: a stale non-socket file at the path is no daemon either. */
const absent = (code: string): boolean => absentSocketCodes.has(code) || code === 'ENOTSOCK';

const reportHasActive = (report: Readonly<Record<string, unknown>>): boolean => {
  if (Array.isArray(report.active) && report.active.length > 0) {
    return true;
  }
  return (Array.isArray(report.lanes) ? report.lanes : []).some(
    (lane) =>
      isRecord(lane) &&
      ((typeof lane.queued === 'number' && lane.queued > 0) ||
        (typeof lane.runningTicket === 'string' && lane.runningTicket.length > 0)),
  );
};

const classifyOutcome = (outcome: RequestOutcome): DaemonProbe => {
  switch (outcome.kind) {
    case 'reply': {
      const message = outcome.message;
      if (message.type !== 'status-result' || !isRecord(message.report)) {
        return 'busy';
      }
      return reportHasActive(message.report) ? 'active' : 'idle';
    }
    case 'timeout':
    case 'closed':
    case 'malformed':
      return 'busy';
    case 'unreachable':
      // Permission or descriptor errors do not prove the daemon is gone; the
      // rewrite is the safe default because `hauler exec` itself falls back to
      // a direct run when it cannot connect.
      return outcome.code !== undefined && absent(outcome.code) ? 'absent' : 'busy';
    default: {
      const exhaustive: never = outcome;
      return exhaustive;
    }
  }
};

/** Lean unix-socket status probe for the `cargo clean` guard. */
export const probeActiveBuilds = async (
  socketPath: string = resolveHookSocketPath(),
  timeoutMs: number = defaultTimeoutMs,
): Promise<DaemonProbe> =>
  classifyOutcome(await requestOutcome({ id: 'hook-status', limit: 1, type: 'status' }, socketPath, timeoutMs));
