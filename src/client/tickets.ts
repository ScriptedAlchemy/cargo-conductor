import { randomBytes } from 'node:crypto';

import * as Effect from 'effect/Effect';

import { resolveDaemonConfig } from '../daemon/config.js';
import type { DaemonConfigShape } from '../daemon/config.js';
import { requestOverSocket } from '../daemon/control.js';
import type {
  AckMessage,
  AwaitResultMessage,
  RequestRecord,
  ResultResultMessage,
} from '../daemon/protocol.js';

import { ensureDaemonRunning } from './ensure-daemon.js';

const shortId = (): string => randomBytes(6).toString('hex');

export const fetchTicket = (
  ticket: string,
  config: DaemonConfigShape = resolveDaemonConfig(),
): Effect.Effect<RequestRecord | null> =>
  requestOverSocket({
    isTerminal: (message) => message.type === 'result-result',
    message: { id: shortId(), ticket, type: 'result' },
    socketPath: config.socketPath,
    timeoutMs: 2_000,
  }).pipe(
    Effect.map((messages) => {
      const result = messages.find(
        (message): message is ResultResultMessage => message.type === 'result-result',
      );
      return result?.request ?? null;
    }),
    Effect.catch(() => Effect.succeed(null)),
  );

export const awaitTicket = (
  ticket: string,
  maxWaitMs: number,
  config: DaemonConfigShape = resolveDaemonConfig(),
): Effect.Effect<{ readonly request: RequestRecord | null; readonly timedOut: boolean }> =>
  requestOverSocket({
    isTerminal: (message) => message.type === 'await-result',
    message: { id: shortId(), maxWaitMs, ticket, type: 'await' },
    socketPath: config.socketPath,
    timeoutMs: maxWaitMs + 2_000,
  }).pipe(
    Effect.map((messages) => {
      const result = messages.find(
        (message): message is AwaitResultMessage => message.type === 'await-result',
      );
      return {
        request: result?.request ?? null,
        timedOut: result?.timedOut ?? true,
      };
    }),
    Effect.catch(() => Effect.succeed({ request: null, timedOut: true })),
  );

export const submitBackground = (
  input: {
    readonly argv: readonly string[];
    readonly cwd: string;
    readonly session?: string;
    readonly host?: string;
  },
  config: DaemonConfigShape = resolveDaemonConfig(),
): Effect.Effect<string | null> =>
  // Cold daemon must not mean "failed to submit": start it like exec does.
  ensureDaemonRunning(config).pipe(
    Effect.ignore,
    Effect.andThen(
      requestOverSocket({
        isTerminal: (message) => message.type === 'ack' || message.type === 'error',
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
      }),
    ),
    Effect.map((messages) => {
      const ack = messages.find((message): message is AckMessage => message.type === 'ack');
      return ack?.ticket ?? null;
    }),
    Effect.catch(() => Effect.succeed(null)),
  );
