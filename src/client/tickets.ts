import { basename } from 'node:path';

import * as Data from 'effect/Data';
import * as Effect from 'effect/Effect';

import { resolveDaemonConfig } from '../daemon/config.js';
import type { DaemonConfigShape } from '../daemon/config.js';
import { requestOverSocket } from '../daemon/control.js';
import type {
  ConnectionClosedError,
  ControlTimeoutError,
  DaemonUnreachableError,
} from '../daemon/control.js';
import type {
  AckMessage,
  AwaitResultMessage,
  ClientMessage,
  ErrorMessage,
  KillResultMessage,
  RequestRecord,
  ResultResultMessage,
  ServerMessage,
} from '../daemon/protocol.js';
import { shortId } from '../lib/id.js';

import { ensureDaemonRunning } from './ensure-daemon.js';
import { formatProgressLine } from './progress.js';

/** The daemon answered this request with an `error` line (malformed request, internal failure). */
export class DaemonRejectedError extends Data.TaggedError('DaemonRejected')<{
  readonly socketPath: string;
  readonly code: ErrorMessage['code'];
  readonly message: string;
}> {}

/**
 * Infrastructure failures stay typed in this library: a daemon that is down
 * is not the same as a ticket that does not exist. Callers convert to
 * fail-open values only at deliberately fail-open boundaries (hooks).
 */
export type TicketSocketError =
  | ConnectionClosedError
  | ControlTimeoutError
  | DaemonUnreachableError
  | DaemonRejectedError;

/**
 * One request, one answer: resolves on the reply carrying this request's id,
 * and fails typed when that reply is the daemon's `error` — otherwise an
 * `await` with a rejected `maxWaitMs` would sit out its whole timeout waiting
 * for an `await-result` the daemon never sends.
 */
const requestReply = <T extends ServerMessage>(
  config: DaemonConfigShape,
  message: ClientMessage,
  timeoutMs: number,
  guard: (message: ServerMessage) => message is T,
): Effect.Effect<T | undefined, TicketSocketError> =>
  requestOverSocket({
    isTerminal: (reply) =>
      reply.id === message.id && (guard(reply) || reply.type === 'error'),
    message,
    socketPath: config.socketPath,
    timeoutMs,
  }).pipe(
    Effect.flatMap((replies) => {
      const rejected = replies.find(
        (reply): reply is ErrorMessage => reply.type === 'error' && reply.id === message.id,
      );
      if (rejected !== undefined) {
        return Effect.fail(
          new DaemonRejectedError({
            code: rejected.code,
            message: rejected.message,
            socketPath: config.socketPath,
          }),
        );
      }
      return Effect.succeed(
        replies.find((reply): reply is T => guard(reply) && reply.id === message.id),
      );
    }),
  );

export const fetchTicket = (
  ticket: string,
  config: DaemonConfigShape = resolveDaemonConfig(),
): Effect.Effect<RequestRecord | null, TicketSocketError> =>
  requestReply(
    config,
    { id: shortId(), ticket, type: 'result' },
    2_000,
    (message): message is ResultResultMessage => message.type === 'result-result',
  ).pipe(Effect.map((result) => result?.request ?? null));

/**
 * Ask the daemon to stop a ticket: a queued job is dropped, a running leader
 * gets SIGTERM (then SIGKILL after the grace period) on its process group.
 * `false` means there was nothing to kill — unknown or already finished.
 */
export const killTicket = (
  ticket: string,
  config: DaemonConfigShape = resolveDaemonConfig(),
): Effect.Effect<boolean, TicketSocketError> =>
  requestReply(
    config,
    { id: shortId(), ticket, type: 'kill' },
    5_000,
    (message): message is KillResultMessage => message.type === 'kill-result',
  ).pipe(Effect.map((result) => result?.killed === true));

const formatSeconds = (ms: number): string => {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return seconds >= 90 ? `${Math.floor(seconds / 60)}m${seconds % 60}s` : `${seconds}s`;
};

const describeAwaitedRecord = (ticket: string, record: RequestRecord | null): string => {
  if (record === null) {
    return `${ticket} is not known to the daemon (yet)`;
  }
  const command = record.argv.slice(1).join(' ');
  const estimate = record.estimateMs === null ? '' : ` (est ~${formatSeconds(record.estimateMs)})`;
  switch (record.status) {
    case 'queued':
      return `${ticket} queued ${formatSeconds(Date.now() - (record.queuedAtMs ?? record.createdAtMs))}${estimate} — ${command}`;
    case 'running':
      return `${ticket} running ${formatSeconds(Date.now() - (record.startedAtMs ?? Date.now()))}${estimate} — ${command}`;
    default:
      return `${ticket} ${record.status}${record.exitCode === null ? '' : ` exit=${record.exitCode}`} — ${command}`;
  }
};

const formatAwaitedRecord = (ticket: string, record: RequestRecord): string => {
  const command = record.argv.slice(1).join(' ');
  switch (record.status) {
    case 'queued':
      return formatProgressLine({
        command,
        delayed: record.delayed,
        elapsedMs: Date.now() - (record.queuedAtMs ?? record.createdAtMs),
        estimateMs: record.estimateMs,
        hold: record.admissionHold,
        kind: 'heartbeat',
        laneName: basename(record.workspaceRoot),
        phase: 'queued',
        queue: record.queue,
        ticket,
        waitingFor: record.waitingFor,
      });
    case 'running':
      return formatProgressLine({
        command,
        elapsedMs: Date.now() - (record.startedAtMs ?? Date.now()),
        estimateMs: record.estimateMs,
        kind: 'heartbeat',
        phase: 'running',
        ticket,
      });
    default:
      return `[cargo-hauler] ${describeAwaitedRecord(ticket, record)}\n`;
  }
};

type TicketStatusFetcher = (
  ticket: string,
  config: DaemonConfigShape,
) => Effect.Effect<RequestRecord | null, unknown>;

export interface AwaitProgress {
  readonly line: string;
  readonly record: RequestRecord | null;
}

/**
 * `awaitTicket` with a heartbeat: while the daemon-side wait blocks, the
 * ticket's live record is polled and reported through `onProgress` so a
 * terminal wait shows queue phase, elapsed time, and the cost estimate
 * instead of silence. Progress is best-effort — a failed poll never fails
 * the await.
 */
export const awaitTicketWithProgress = (
  ticket: string,
  maxWaitMs: number,
  onProgress: (progress: AwaitProgress) => void,
  config: DaemonConfigShape = resolveDaemonConfig(),
  intervalMs = 5_000,
  fetchStatus: TicketStatusFetcher = fetchTicket,
): Effect.Effect<
  { readonly request: RequestRecord | null; readonly timedOut: boolean },
  TicketSocketError
> => {
  const beat: Effect.Effect<never> = Effect.gen(function* () {
    let observed = false;
    for (;;) {
      const poll = yield* fetchStatus(ticket, config).pipe(
        Effect.match({
          onFailure: () => ({ _tag: 'Failed' as const }),
          onSuccess: (record) => ({ _tag: 'Observed' as const, record }),
        }),
      );
      switch (poll._tag) {
        case 'Failed':
          if (!observed) {
            onProgress({
              line: `[cargo-hauler] ${ticket} is not known to the daemon (yet)\n`,
              record: null,
            });
          }
          break;
        case 'Observed':
          if (poll.record === null) {
            onProgress({
              line: observed
                ? `[cargo-hauler] ${ticket} status check failed, retrying\n`
                : `[cargo-hauler] ${ticket} is not known to the daemon (yet)\n`,
              record: null,
            });
          } else {
            observed = true;
            onProgress({ line: formatAwaitedRecord(ticket, poll.record), record: poll.record });
          }
          break;
        default: {
          const exhaustive: never = poll;
          return exhaustive;
        }
      }
      yield* Effect.sleep(intervalMs);
    }
  });
  return awaitTicket(ticket, maxWaitMs, config).pipe(Effect.raceFirst(beat));
};

export const awaitTicket = (
  ticket: string,
  maxWaitMs: number,
  config: DaemonConfigShape = resolveDaemonConfig(),
): Effect.Effect<
  { readonly request: RequestRecord | null; readonly timedOut: boolean },
  TicketSocketError
> =>
  requestReply(
    config,
    { id: shortId(), maxWaitMs, ticket, type: 'await' },
    maxWaitMs + 2_000,
    (message): message is AwaitResultMessage => message.type === 'await-result',
  ).pipe(
    Effect.map((result) => ({
      request: result?.request ?? null,
      timedOut: result?.timedOut ?? true,
    })),
  );

export interface BackgroundSubmitInput {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly session?: string;
  readonly host?: string;
  /** Tickets that must settle before this request may start (`--after`). */
  readonly after?: readonly string[];
}

/** The daemon's acknowledgement of a background submission, less the wire envelope. */
export interface BackgroundSubmitAck {
  readonly ticket: string;
  /** Leaders expected to run before this one in its lane (running head included). */
  readonly position: number;
  /** The tickets `position` counts; absent when the daemon predates the field. */
  readonly ahead?: readonly string[];
  readonly waitEtaMs?: number;
  /** Prerequisites still unsettled at submission. */
  readonly waitingFor?: readonly string[];
  /** Set when the request rode an in-flight run instead of queueing. */
  readonly attachedTo?: string;
}

/**
 * Submits a background request and returns the daemon's acknowledgement, or
 * null when the connection ended without one. A daemon `error` line (an
 * unparseable command, an unknown `--after` ticket) fails typed as
 * `DaemonRejected` so the caller can show the reason instead of a generic
 * "failed to submit".
 */
export const submitBackgroundAck = (
  input: BackgroundSubmitInput,
  config: DaemonConfigShape = resolveDaemonConfig(),
): Effect.Effect<BackgroundSubmitAck | null, TicketSocketError> =>
  // Cold daemon must not mean "failed to submit": start it like exec does.
  ensureDaemonRunning(config).pipe(
    Effect.ignore,
    Effect.andThen(
      // No `holdStop`: the daemon's default for a background request is
      // false, the same as `exec --bg --session`. Background tickets never
      // hold a stop; the two entry points used to disagree.
      requestReply(
        config,
        {
          argv: [...input.argv],
          background: true,
          cwd: input.cwd,
          id: shortId(),
          type: 'exec',
          ...(input.host === undefined ? {} : { host: input.host }),
          ...(input.session === undefined ? {} : { session: input.session }),
          ...(input.after === undefined || input.after.length === 0
            ? {}
            : { after: [...input.after] }),
        },
        5_000,
        (message): message is AckMessage => message.type === 'ack',
      ),
    ),
    Effect.map((message): BackgroundSubmitAck | null =>
      message === undefined
        ? null
        : {
            ticket: message.ticket,
            position: message.position,
            ...(message.ahead === undefined ? {} : { ahead: message.ahead }),
            ...(message.waitEtaMs === undefined ? {} : { waitEtaMs: message.waitEtaMs }),
            ...(message.waitingFor === undefined ? {} : { waitingFor: message.waitingFor }),
            ...(message.attachedTo === undefined ? {} : { attachedTo: message.attachedTo }),
          },
    ),
  );

/** `submitBackgroundAck` reduced to the ticket, for callers that only need the id. */
export const submitBackground = (
  input: BackgroundSubmitInput,
  config: DaemonConfigShape = resolveDaemonConfig(),
): Effect.Effect<string | null, TicketSocketError> =>
  submitBackgroundAck(input, config).pipe(Effect.map((ack) => ack?.ticket ?? null));
