import { basename } from 'node:path';

import * as Effect from 'effect/Effect';

import { resolveDaemonConfig } from '../daemon/config.js';
import type { DaemonConfigShape } from '../daemon/config.js';
import { requestExpecting } from '../daemon/control.js';
import type {
  ConnectionClosedError,
  ControlTimeoutError,
  DaemonUnreachableError,
} from '../daemon/control.js';
import type {
  AckMessage,
  AwaitResultMessage,
  ErrorMessage,
  RequestRecord,
  ResultResultMessage,
} from '../daemon/protocol.js';
import { shortId } from '../lib/id.js';

import { ensureDaemonRunning } from './ensure-daemon.js';
import { formatProgressLine } from './progress.js';

/**
 * Infrastructure failures stay typed in this library: a daemon that is down
 * is not the same as a ticket that does not exist. Callers convert to
 * fail-open values only at deliberately fail-open boundaries (hooks).
 */
export type TicketSocketError = ConnectionClosedError | ControlTimeoutError | DaemonUnreachableError;

export const fetchTicket = (
  ticket: string,
  config: DaemonConfigShape = resolveDaemonConfig(),
): Effect.Effect<RequestRecord | null, TicketSocketError> =>
  requestExpecting(
    {
      message: { id: shortId(), ticket, type: 'result' },
      socketPath: config.socketPath,
      timeoutMs: 2_000,
    },
    (message): message is ResultResultMessage => message.type === 'result-result',
  ).pipe(Effect.map((result) => result?.request ?? null));

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
  requestExpecting(
    {
      message: { id: shortId(), maxWaitMs, ticket, type: 'await' },
      socketPath: config.socketPath,
      timeoutMs: maxWaitMs + 2_000,
    },
    (message): message is AwaitResultMessage => message.type === 'await-result',
  ).pipe(
    Effect.map((result) => ({
      request: result?.request ?? null,
      timedOut: result?.timedOut ?? true,
    })),
  );

export const submitBackground = (
  input: {
    readonly argv: readonly string[];
    readonly cwd: string;
    readonly session?: string;
    readonly host?: string;
  },
  config: DaemonConfigShape = resolveDaemonConfig(),
): Effect.Effect<string | null, TicketSocketError> =>
  // Cold daemon must not mean "failed to submit": start it like exec does.
  ensureDaemonRunning(config).pipe(
    Effect.ignore,
    Effect.andThen(
      requestExpecting(
        {
          message: {
            argv: [...input.argv],
            background: true,
            cwd: input.cwd,
            holdStop: input.session !== undefined,
            id: shortId(),
            type: 'exec',
            ...(input.host === undefined ? {} : { host: input.host }),
            ...(input.session === undefined ? {} : { session: input.session }),
          },
          socketPath: config.socketPath,
          timeoutMs: 5_000,
        },
        (message): message is AckMessage | ErrorMessage =>
          message.type === 'ack' || message.type === 'error',
      ),
    ),
    Effect.map((message) => (message?.type === 'ack' ? message.ticket : null)),
  );
