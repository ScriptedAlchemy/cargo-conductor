/**
 * The primitives for replacing a running daemon, shared by the automatic
 * replacement in `ensureDaemonRunning` (a daemon of another version answers
 * the socket) and the manual `hauler daemon restart`. A leaf on purpose:
 * `lifecycle.ts` imports `ensure-daemon.ts`, and both import this.
 */

import * as Data from 'effect/Data';
import * as Effect from 'effect/Effect';

import { formatMs } from '../lib/format.js';
import { isRecord } from '../lib/guards.js';
import { shortId } from '../lib/id.js';

import { pingDaemon, requestOverSocket } from './control.js';

/** What a `pong` says about the daemon behind the socket. */
export interface DaemonIdentity {
  readonly pid: number;
  readonly startedAtMs: number;
  readonly version: string;
}

/** Who is behind the socket, or null when nothing answered a ping in time. */
export const daemonIdentity = (
  socketPath: string,
  timeoutMs = 1_000,
): Effect.Effect<DaemonIdentity | null> =>
  pingDaemon(socketPath, timeoutMs).pipe(
    Effect.map(
      (pong): DaemonIdentity => ({
        pid: pong.pid,
        startedAtMs: pong.startedAtMs,
        version: pong.version,
      }),
    ),
    Effect.orElseSucceed(() => null),
  );

/**
 * How long a daemon gets to exit after acknowledging a shutdown request —
 * the same window its own signal handler allows before forcing the exit.
 */
export const exitGraceMs = 5_000;

/** `kill -0`: EPERM is another user's live process, ESRCH is gone. */
export const processAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isRecord(error) && error.code === 'EPERM';
  }
};

export interface ExitWaitOptions {
  /** How long the old daemon gets to exit after acknowledging the shutdown. */
  readonly exitGraceMs: number;
  readonly pollMs: number;
  /** Whether the process still exists (`kill -0`). */
  readonly processAlive: (pid: number) => boolean;
}

/** True once the pid is gone, false when it is still there at the end of the grace. */
export const waitForExit = (pid: number, options: ExitWaitOptions): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const deadline = Date.now() + options.exitGraceMs;
    while (options.processAlive(pid)) {
      if (Date.now() >= deadline) {
        return false;
      }
      yield* Effect.sleep(options.pollMs);
    }
    return true;
  });

/**
 * How the daemon took a `shutdown` request: it answered `shutting-down`, it
 * hung up first (already on its way out), it never answered, or nothing was
 * listening.
 */
export type ShutdownAck = 'acknowledged' | 'connection-closed' | 'timeout' | 'unreachable';

export const requestShutdown = (
  socketPath: string,
  timeoutMs = 5_000,
): Effect.Effect<ShutdownAck> =>
  Effect.suspend(() =>
    requestOverSocket({
      isTerminal: (message) => message.type === 'shutting-down',
      message: { id: shortId(), type: 'shutdown' },
      socketPath,
      timeoutMs,
    }),
  ).pipe(
    Effect.as<ShutdownAck>('acknowledged'),
    Effect.catchTags({
      ConnectionClosed: () => Effect.succeed<ShutdownAck>('connection-closed'),
      ControlTimeout: () => Effect.succeed<ShutdownAck>('timeout'),
      DaemonUnreachable: () => Effect.succeed<ShutdownAck>('unreachable'),
    }),
  );

/** The one text for a daemon that outlived the grace after a shutdown request. */
export const notReplacedMessage = (daemon: DaemonIdentity, graceMs: number): string =>
  `cargo-hauler daemon pid ${daemon.pid} (${daemon.version}) is still running ${formatMs(graceMs)} after the shutdown request; not restarted — retry once it has exited, or stop it with \`hauler daemon stop\``;

/**
 * A daemon of another version acknowledged the shutdown request but was
 * still running at the end of the grace, so this build's daemon was not
 * started. The daemon is never signalled past the request. `message` is
 * `notReplacedMessage` for the same daemon and grace.
 */
export class DaemonNotReplacedError extends Data.TaggedError('DaemonNotReplaced')<{
  readonly socketPath: string;
  readonly daemon: DaemonIdentity;
  readonly graceMs: number;
  readonly message: string;
}> {
  constructor(fields: {
    readonly socketPath: string;
    readonly daemon: DaemonIdentity;
    readonly graceMs: number;
  }) {
    super({ ...fields, message: notReplacedMessage(fields.daemon, fields.graceMs) });
  }
}
