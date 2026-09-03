import { resolveHookSocketPath } from './paths.js';
import { requestJson } from './rpc.js';
import { isRecord } from './shared.js';

const defaultTimeoutMs = 250;

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

/**
 * Lean unix-socket status probe. `true` when the daemon has queued/running
 * work, `false` when it is idle, `null` when the socket cannot be reached.
 */
export const probeActiveBuilds = async (
  socketPath: string = resolveHookSocketPath(),
  timeoutMs: number = defaultTimeoutMs,
): Promise<boolean | null> => {
  const message = await requestJson(
    { id: 'hook-status', limit: 1, type: 'status' },
    socketPath,
    timeoutMs,
  );
  if (message === null || message.type !== 'status-result' || !isRecord(message.report)) {
    return null;
  }
  return reportHasActive(message.report);
};
