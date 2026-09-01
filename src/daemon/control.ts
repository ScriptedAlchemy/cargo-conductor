import { randomBytes } from 'node:crypto';

import * as Socket from '@effect/platform/Socket';
import * as NodeSocket from '@effect/platform-node/NodeSocket';
import * as Data from 'effect/Data';
import * as Deferred from 'effect/Deferred';
import * as Effect from 'effect/Effect';
import * as Fiber from 'effect/Fiber';
import type { Scope } from 'effect/Scope';

import type { ClientMessage, PongMessage, ServerMessage } from './protocol.js';
import { encodeClientMessage, LineBuffer, parseServerMessageLine } from './protocol.js';

export class DaemonUnreachableError extends Data.TaggedError('DaemonUnreachable')<{
  readonly socketPath: string;
  readonly cause: unknown;
}> {}

export class ControlTimeoutError extends Data.TaggedError('ControlTimeout')<{
  readonly socketPath: string;
  readonly timeoutMs: number;
  readonly received: readonly ServerMessage[];
}> {}

export class ConnectionClosedError extends Data.TaggedError('ConnectionClosed')<{
  readonly socketPath: string;
  readonly received: readonly ServerMessage[];
}> {}

export interface RequestOverSocketOptions {
  readonly socketPath: string;
  readonly message: ClientMessage;
  /** Resolve once a received message satisfies this predicate. */
  readonly isTerminal: (message: ServerMessage) => boolean;
  readonly timeoutMs?: number;
}

const defaultTimeoutMs = 10_000;

const snapshot = (received: readonly ServerMessage[]): readonly ServerMessage[] => received.slice();

const mapSocketFailure = (
  error: Socket.SocketError,
  socketPath: string,
  received: readonly ServerMessage[],
): DaemonUnreachableError | ConnectionClosedError => {
  switch (error.reason) {
    case 'Open':
    case 'OpenTimeout':
      return new DaemonUnreachableError({ socketPath, cause: error });
    case 'Write':
    case 'Read':
    case 'Close':
      return new ConnectionClosedError({ socketPath, received: snapshot(received) });
    default: {
      const _exhaustive: never = error;
      return _exhaustive;
    }
  }
};

const runRequest = (
  options: RequestOverSocketOptions,
): Effect.Effect<
  readonly ServerMessage[],
  DaemonUnreachableError | ControlTimeoutError | ConnectionClosedError,
  Scope
> =>
  Effect.gen(function* () {
    const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
    const received: ServerMessage[] = [];
    const lines = new LineBuffer();
    const opened = yield* Deferred.make<void>();
    const terminal = yield* Deferred.make<readonly ServerMessage[]>();

    const finishAfterPeerGone = (): Effect.Effect<
      readonly ServerMessage[],
      ConnectionClosedError
    > => {
      const messages = snapshot(received);
      if (messages.some(options.isTerminal)) {
        return Effect.succeed(messages);
      }
      return Effect.fail(
        new ConnectionClosedError({
          socketPath: options.socketPath,
          received: messages,
        }),
      );
    };

    const afterPumpFailure = (
      error: Socket.SocketError,
    ): Effect.Effect<readonly ServerMessage[], DaemonUnreachableError | ConnectionClosedError> => {
      const mapped = mapSocketFailure(error, options.socketPath, received);
      switch (mapped._tag) {
        case 'DaemonUnreachable':
          return Effect.fail(mapped);
        case 'ConnectionClosed':
          return finishAfterPeerGone();
        default: {
          const _exhaustive: never = mapped;
          return _exhaustive;
        }
      }
    };

    const socket = yield* NodeSocket.makeNet({
      path: options.socketPath,
      openTimeout: 2000,
    }).pipe(Effect.mapError((error) => mapSocketFailure(error, options.socketPath, received)));

    const write = yield* socket.writer;

    const pump: Effect.Effect<
      readonly ServerMessage[],
      DaemonUnreachableError | ConnectionClosedError
    > = socket
      .run(
        (data) => {
          let sawTerminal = false;
          for (const line of lines.push(data)) {
            const message = parseServerMessageLine(line);
            received.push(message);
            if (options.isTerminal(message)) {
              sawTerminal = true;
            }
          }
          return sawTerminal
            ? Deferred.succeed(terminal, snapshot(received)).pipe(Effect.asVoid)
            : Effect.void;
        },
        { onOpen: Deferred.succeed(opened, undefined).pipe(Effect.asVoid) },
      )
      .pipe(
        Effect.matchEffect({
          onFailure: afterPumpFailure,
          onSuccess: finishAfterPeerGone,
        }),
      );

    const pumpFiber = yield* Effect.forkScoped(pump);

    yield* Deferred.await(opened).pipe(Effect.raceFirst(Fiber.join(pumpFiber)));
    yield* write(encodeClientMessage(options.message)).pipe(
      Effect.mapError((error) => mapSocketFailure(error, options.socketPath, received)),
    );

    return yield* Deferred.await(terminal).pipe(
      Effect.raceFirst(Fiber.join(pumpFiber)),
      Effect.timeoutFail({
        duration: timeoutMs,
        onTimeout: () =>
          new ControlTimeoutError({
            socketPath: options.socketPath,
            timeoutMs,
            received: snapshot(received),
          }),
      }),
    );
  });

export const requestOverSocket = (
  options: RequestOverSocketOptions,
): Effect.Effect<
  readonly ServerMessage[],
  DaemonUnreachableError | ControlTimeoutError | ConnectionClosedError
> => Effect.scoped(runRequest(options));

export const pingDaemon = (
  socketPath: string,
  timeoutMs?: number,
): Effect.Effect<PongMessage, DaemonUnreachableError | ControlTimeoutError | ConnectionClosedError> =>
  Effect.gen(function* () {
    const id = randomBytes(6).toString('hex');
    const messages = yield* requestOverSocket({
      socketPath,
      message: { type: 'ping', id },
      isTerminal: (message) => message.type === 'pong' && message.id === id,
      timeoutMs,
    });
    return messages.find((message) => message.type === 'pong' && message.id === id) as PongMessage;
  });
