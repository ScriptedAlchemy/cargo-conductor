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
