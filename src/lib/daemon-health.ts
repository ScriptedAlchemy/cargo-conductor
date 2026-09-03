import { existsSync } from 'node:fs';

import * as Effect from 'effect/Effect';

import type { DaemonConfigShape } from '../daemon/config.js';
import { requestExpecting } from '../daemon/control.js';
import type { StatusResultMessage } from '../daemon/protocol.js';
import { shortId } from './id.js';

/**
 * What one bounded status probe proved about the daemon. Every shape is
 * honest about *why* it is not `running`: a missing socket and a refused
 * connection are a stopped daemon, an accept or read that did not finish in
 * time is a live but saturated one, and a surface that deliberately skipped
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
    }
  | { readonly state: 'stopped'; readonly reason: 'socket-missing' | 'connection-refused' }
  | { readonly state: 'unresponsive'; readonly reason: 'accept-timeout' | 'connection-closed'; readonly timeoutMs: number }
  | { readonly state: 'unprobed'; readonly reason: 'event-surface' };

/** Bounded so a saturated daemon costs a document at most this long. */
export const healthProbeTimeoutMs = 750;

const socketPresent = (config: DaemonConfigShape, platform: NodeJS.Platform): boolean =>
  // Windows named pipes are not filesystem entries; only Unix sockets can be
  // ruled out without opening them.
  platform === 'win32' || existsSync(config.socketPath);

const runningHealth = (message: StatusResultMessage, latencyMs: number): DaemonHealth => {
  const report = message.report;
  const running = report.active.filter((record) => record.status === 'running');
  return {
    busyLanes: report.lanes.filter((lane) => lane.queued > 0 || lane.runningTicket !== null).length,
    latencyMs,
    maxConcurrent: report.maxConcurrent,
    pid: report.pid,
    queued: report.active.filter((record) => record.status === 'queued' || record.status === 'requested').length,
    riding: running.filter((record) => record.attachedTo !== null).length,
    running: running.filter((record) => record.attachedTo === null).length,
    startedAtMs: report.startedAtMs,
    state: 'running',
  };
};

/**
 * One small `status` read (recent limit 1) instead of a bare ping: the same
 * round trip that proves liveness also yields the lane summary the shell
 * shows, and it is the request the hooks already send on every probe.
 */
export const probeDaemonHealth = (
  config: DaemonConfigShape,
  options: { readonly platform?: NodeJS.Platform; readonly signal?: AbortSignal; readonly timeoutMs?: number } = {},
): Promise<DaemonHealth> => {
  const platform = options.platform ?? process.platform;
  if (!socketPresent(config, platform)) {
    return Promise.resolve({ reason: 'socket-missing', state: 'stopped' });
  }
  const timeoutMs = options.timeoutMs ?? healthProbeTimeoutMs;
  const startedAt = Date.now();
  const probe: Effect.Effect<DaemonHealth> = requestExpecting(
    {
      message: { id: shortId(), limit: 1, type: 'status' },
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
    Effect.catchTags({
      ConnectionClosed: () =>
        Effect.succeed<DaemonHealth>({ reason: 'connection-closed', state: 'unresponsive', timeoutMs }),
      ControlTimeout: () =>
        Effect.succeed<DaemonHealth>({ reason: 'accept-timeout', state: 'unresponsive', timeoutMs }),
      DaemonUnreachable: () =>
        Effect.succeed<DaemonHealth>({ reason: 'connection-refused', state: 'stopped' }),
    }),
  );
  return Effect.runPromise(probe, options.signal === undefined ? undefined : { signal: options.signal });
};
