import { resolveHookSocketPath } from './paths.js';
import { requestJson } from './rpc.js';
import { isRecord } from './shared.js';

const defaultTimeoutMs = 250;

type StatusLike = {
  readonly active?: readonly unknown[];
  readonly lanes?: readonly { readonly queued?: number; readonly runningTicket?: string | null }[];
};

const reportHasActive = (report: StatusLike): boolean => {
  if ((report.active?.length ?? 0) > 0) {
    return true;
  }
  return (report.lanes ?? []).some(
    (lane) => (lane.queued ?? 0) > 0 || (lane.runningTicket !== undefined && lane.runningTicket !== null),
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
  return reportHasActive(message.report as StatusLike);
};
