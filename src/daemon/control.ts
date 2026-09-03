import * as NodeSocket from '@effect/platform-node/NodeSocket';
import * as Data from 'effect/Data';
import * as Deferred from 'effect/Deferred';
import * as Effect from 'effect/Effect';
import * as Fiber from 'effect/Fiber';
import type { Scope } from 'effect/Scope';
import * as Socket from 'effect/unstable/socket/Socket';

import { shortId } from '../lib/id.js';

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

/** How long a client waits for the daemon to accept a connection. */
export const openTimeoutMs = 2_000;

export const mapSocketFailure = (
  error: Socket.SocketError,
  socketPath: string,
  received: readonly ServerMessage[] = [],
): DaemonUnreachableError | ControlTimeoutError | ConnectionClosedError => {
  switch (error.reason._tag) {
    case 'SocketOpenError':
      // A refused or absent socket is a stopped daemon; an accept that never
      // arrives is a live daemon too busy to answer (observed under heavy
      // machine load), and must not read as "not running".
      return error.reason.kind === 'Timeout'
        ? new ControlTimeoutError({ socketPath, timeoutMs: openTimeoutMs, received: snapshot(received) })
        : new DaemonUnreachableError({ socketPath, cause: error });
    case 'SocketWriteError':
    case 'SocketReadError':
    case 'SocketCloseError':
      return new ConnectionClosedError({ socketPath, received: snapshot(received) });
    default: {
      const _exhaustive: never = error.reason;
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
    ): Effect.Effect<
      readonly ServerMessage[],
      DaemonUnreachableError | ControlTimeoutError | ConnectionClosedError
    > => {
      const mapped = mapSocketFailure(error, options.socketPath, received);
      switch (mapped._tag) {
        case 'DaemonUnreachable':
        case 'ControlTimeout':
          return Effect.fail(mapped);
        case 'ConnectionClosed':
          return finishAfterPeerGone();
        default: {
          const _exhaustive: never = mapped;
          return _exhaustive;
        }
      }
    };

    // v4 sockets connect lazily: open failures surface through the pump's
    // `socket.run`, which routes them via mapSocketFailure below.
    const socket = yield* NodeSocket.makeNet({
      path: options.socketPath,
      openTimeout: openTimeoutMs,
    });

    const write = yield* socket.writer;

    const pump: Effect.Effect<
      readonly ServerMessage[],
      DaemonUnreachableError | ControlTimeoutError | ConnectionClosedError
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
      Effect.timeoutOrElse({
        duration: timeoutMs,
        orElse: () =>
          Effect.fail(
            new ControlTimeoutError({
              socketPath: options.socketPath,
              timeoutMs,
              received: snapshot(received),
            }),
          ),
      }),
    );
  });

export const requestOverSocket = (
  options: RequestOverSocketOptions,
): Effect.Effect<
  readonly ServerMessage[],
  DaemonUnreachableError | ControlTimeoutError | ConnectionClosedError
> => Effect.scoped(runRequest(options));

export const requestExpecting = <T extends ServerMessage>(
  options: Omit<RequestOverSocketOptions, 'isTerminal'>,
  guard: (message: ServerMessage) => message is T,
): Effect.Effect<
  T | undefined,
  DaemonUnreachableError | ControlTimeoutError | ConnectionClosedError
> =>
  requestOverSocket({ ...options, isTerminal: guard }).pipe(
    Effect.map((messages) => messages.find(guard)),
  );

export const pingDaemon = (
  socketPath: string,
  timeoutMs?: number,
): Effect.Effect<PongMessage, DaemonUnreachableError | ControlTimeoutError | ConnectionClosedError> =>
  Effect.suspend(() => {
    const id = shortId();
    return requestExpecting(
      {
        socketPath,
        message: { type: 'ping', id },
        timeoutMs,
      },
      (message): message is PongMessage => message.type === 'pong' && message.id === id,
    ).pipe(
      Effect.flatMap((pong) =>
        pong === undefined
          ? Effect.fail(new ConnectionClosedError({ socketPath, received: [] }))
          : Effect.succeed(pong),
      ),
    );
  });
