import { statSync } from 'node:fs';

import * as Effect from 'effect/Effect';
import * as Schedule from 'effect/Schedule';

import {
  defaultEnsureDependencies,
  ensureDaemonVersion,
} from '../client/ensure-daemon.js';
import type { DaemonConfigShape } from '../daemon/config.js';
import {
  pingDaemon,
  requestExpecting,
  type DaemonUnreachableError,
} from '../daemon/control.js';
import type { StatusResultMessage } from '../daemon/protocol.js';
import { requestShutdown } from '../daemon/shutdown.js';
import { isRecord } from './guards.js';
import { shortId } from './id.js';
import { socketErrorCode } from './socket-errors.js';

/**
 * What one bounded status probe proved about the daemon. Every shape is
 * honest about *why* it is not `running`: a missing socket and a refused
 * connection are a stopped daemon, an accept or read that did not finish in
 * time is a live but saturated one, an open that failed for any other reason
 * (permissions, descriptor exhaustion) is `unreachable` with the errno so the
 * operator sees the actionable cause, and a surface that deliberately skipped
 * the probe says so instead of guessing.
 */
export type DaemonHealth =
  | {
      readonly state: 'running';
      readonly pid: number;
      readonly startedAtMs: number;
      readonly latencyMs: number;
      /** Leaders: running requests that hold an admission permit. */
      readonly running: number;
      /** Riders: running requests attached to a leader's process (no permit). */
      readonly riding: number;
      readonly queued: number;
      readonly busyLanes: number;
      readonly maxConcurrent: number;
      /** The daemon's release version. */
      readonly version: string;
    }
  | { readonly state: 'stopped'; readonly reason: 'socket-missing' | 'connection-refused' }
  | {
      readonly state: 'unresponsive';
      /** `accept-timeout`: never accepted; `answer-timeout`: accepted but never sent `status-result`. */
      readonly reason: 'accept-timeout' | 'answer-timeout' | 'connection-closed';
      readonly timeoutMs: number;
    }
  | { readonly state: 'unreachable'; readonly reason: 'open-failed'; readonly detail: string }
  | { readonly state: 'unprobed'; readonly reason: 'event-surface' };

/** Bounded so a saturated daemon costs a document at most this long — for the accept and for the answer. */
export const healthProbeTimeoutMs = 750;

/**
 * Whether the Unix socket can be ruled out without opening it. Only a definite
 * `ENOENT` says "missing": a stat that fails for any other reason (a state
 * directory without search permission, say) is not evidence of absence, so the
 * probe goes on to attempt the open and reports that failure with its errno.
 * Windows named pipes are not filesystem entries and are never ruled out here.
 */
const socketDefinitelyMissing = (config: DaemonConfigShape, platform: NodeJS.Platform): boolean => {
  if (platform === 'win32') {
    return false;
  }
  try {
    statSync(config.socketPath);
    return false;
  } catch (error) {
    return isRecord(error) && error.code === 'ENOENT';
  }
};

const runningHealth = (message: StatusResultMessage, latencyMs: number): DaemonHealth => {
  const report = message.report;
  const running = report.active.filter((record) => record.status === 'running');
  return {
    busyLanes: report.lanes.filter(
      (lane) =>
        lane.queued > 0 ||
        lane.runningTicket !== null ||
        lane.executingTickets.length > 0,
    ).length,
    latencyMs,
    maxConcurrent: report.maxConcurrent,
    pid: report.pid,
    queued: report.active.filter((record) => record.status === 'queued' || record.status === 'requested').length,
    riding: running.filter((record) => record.attachedTo !== null).length,
    running: running.filter((record) => record.attachedTo === null).length,
    startedAtMs: report.startedAtMs,
    state: 'running',
    version: report.version,
  };
};

/** The errno (`ECONNREFUSED`, `EACCES`, `EMFILE`, …) behind a failed socket open, when Node supplied one. */
const openFailureCode = (error: DaemonUnreachableError): string | undefined =>
  socketErrorCode(error.cause) ?? undefined;

const openFailureMessage = (error: DaemonUnreachableError): string => {
  const socketError: unknown = error.cause;
  const cause: unknown = isRecord(socketError) && isRecord(socketError.reason) ? socketError.reason.cause : undefined;
  return cause instanceof Error ? cause.message : String(cause ?? 'socket open failed');
};

/**
 * A refused connection (or a socket path that vanished between the existence
 * check and the open) is a stopped daemon. Anything else Node reports for a
 * present socket — `EACCES`, `EMFILE`, `EPERM` — is not evidence that the
 * daemon is down, and is surfaced with its code instead of being folded into
 * "stopped".
 */
const unreachableHealth = (error: DaemonUnreachableError): DaemonHealth => {
  const code = openFailureCode(error);
  switch (code) {
    case 'ECONNREFUSED':
      return { reason: 'connection-refused', state: 'stopped' };
    case 'ENOENT':
      return { reason: 'socket-missing', state: 'stopped' };
    case undefined:
      return { detail: openFailureMessage(error), reason: 'open-failed', state: 'unreachable' };
    default:
      return { detail: `${code}: ${openFailureMessage(error)}`, reason: 'open-failed', state: 'unreachable' };
  }
};

/**
 * One small `status` read (recent limit 1) instead of a bare ping: the same
 * round trip that proves liveness also yields the lane summary the shell
 * shows, and it is the request the hooks already send on every probe. The
 * budget bounds both the connection accept and the answer.
 */
export const probeDaemonHealth = (
  config: DaemonConfigShape,
  options: { readonly platform?: NodeJS.Platform; readonly signal?: AbortSignal; readonly timeoutMs?: number } = {},
): Promise<DaemonHealth> => {
  const platform = options.platform ?? process.platform;
  if (socketDefinitelyMissing(config, platform)) {
    return Promise.resolve({ reason: 'socket-missing', state: 'stopped' });
  }
  const timeoutMs = options.timeoutMs ?? healthProbeTimeoutMs;
  const startedAt = Date.now();
  const probe: Effect.Effect<DaemonHealth> = ensureDaemonVersion(
    config,
    {
      ...defaultEnsureDependencies,
      exitGraceMs: timeoutMs,
      requestShutdown: (socketPath) => requestShutdown(socketPath, timeoutMs),
      waitForDaemon: (socketPath) =>
        pingDaemon(socketPath, Math.min(timeoutMs, 250)).pipe(
          Effect.retry(
            Schedule.spaced('50 millis').pipe(
              Schedule.upTo({ duration: `${timeoutMs} millis` }),
            ),
          ),
        ),
    },
    timeoutMs,
  ).pipe(
    Effect.flatMap((daemon) =>
      daemon === null
        ? Effect.succeed<DaemonHealth>({ reason: 'connection-refused', state: 'stopped' })
        : requestExpecting(
            {
              message: { id: shortId(), limit: 1, type: 'status' },
              openTimeoutMs: timeoutMs,
              socketPath: config.socketPath,
              timeoutMs,
            },
            (message): message is StatusResultMessage => message.type === 'status-result',
          ).pipe(
            Effect.map((message): DaemonHealth =>
              message === undefined
                ? { reason: 'connection-closed', state: 'unresponsive', timeoutMs }
                : runningHealth(message, Date.now() - startedAt),
            ),
          ),
    ),
    Effect.catchTags({
      ConnectionClosed: () =>
        Effect.succeed<DaemonHealth>({ reason: 'connection-closed', state: 'unresponsive', timeoutMs }),
      ControlTimeout: (error) =>
        Effect.succeed<DaemonHealth>({
          reason: error.phase === 'open' ? 'accept-timeout' : 'answer-timeout',
          state: 'unresponsive',
          timeoutMs,
        }),
      DaemonUnreachable: (error) => Effect.succeed<DaemonHealth>(unreachableHealth(error)),
      DaemonNotReplaced: (error) =>
        Effect.succeed<DaemonHealth>({
          detail: error.message,
          reason: 'open-failed',
          state: 'unreachable',
        }),
      DaemonReplacementFailed: (error) =>
        Effect.succeed<DaemonHealth>({
          detail: `replacement daemon failed its version handshake (${error.cause._tag})`,
          reason: 'open-failed',
          state: 'unreachable',
        }),
      SpawnDaemonError: (error) =>
        Effect.succeed<DaemonHealth>({
          detail: `replacement daemon could not be started: ${error.cause instanceof Error ? error.cause.message : String(error.cause)}`,
          reason: 'open-failed',
          state: 'unreachable',
        }),
    }),
  );
  return Effect.runPromise(probe, options.signal === undefined ? undefined : { signal: options.signal });
};
