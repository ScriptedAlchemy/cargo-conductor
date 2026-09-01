import { randomBytes } from 'node:crypto';

import * as NodeServices from '@effect/platform-node/NodeServices';
import * as NodeSocket from '@effect/platform-node/NodeSocket';
import * as Deferred from 'effect/Deferred';
import * as Effect from 'effect/Effect';
import * as Fiber from 'effect/Fiber';
import * as Ref from 'effect/Ref';
import * as Schedule from 'effect/Schedule';
import type { Scope } from 'effect/Scope';
import * as Socket from 'effect/unstable/socket/Socket';

import { executeCargo } from '../daemon/executor.js';
import { resolveDaemonConfig } from '../daemon/config.js';
import type { DaemonConfigShape } from '../daemon/config.js';
import {
  ConnectionClosedError,
  DaemonUnreachableError,
} from '../daemon/control.js';
import {
  encodeClientMessage,
  LineBuffer,
  parseServerMessageLine,
} from '../daemon/protocol.js';
import type { ExitMessage, ServerMessage } from '../daemon/protocol.js';

import { ensureDaemonRunning } from './ensure-daemon.js';
import { shouldAutoBackground } from './host-cap.js';
import { formatProgressLine } from './progress.js';

export interface ExecIo {
  readonly writeStderr: (data: string | Uint8Array) => void;
  readonly writeStdout: (data: Uint8Array) => void;
}

export interface RunExecOptions {
  readonly argv: readonly string[];
  readonly autoSpawn?: boolean;
  readonly background?: boolean;
  readonly config?: DaemonConfigShape;
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly ensureDaemon?: () => Effect.Effect<void, unknown>;
  readonly heartbeatMs?: number;
  readonly host?: string;
  readonly io: ExecIo;
  readonly session?: string;
  readonly workspaceRoot?: string;
}

export interface RunExecResult {
  readonly exitCode: number;
  readonly mode: 'brokered' | 'passthrough';
  readonly ticket?: string;
}

const defaultHeartbeatMs = 15_000;

const shortId = (): string => randomBytes(6).toString('hex');

const writeChannel = (io: ExecIo, channel: 'stdout' | 'stderr', data: Uint8Array): void => {
  if (channel === 'stdout') {
    io.writeStdout(data);
    return;
  }
  io.writeStderr(data);
};

const mapOpenError = (error: Socket.SocketError, socketPath: string): DaemonUnreachableError | ConnectionClosedError => {
  switch (error.reason._tag) {
    case 'SocketOpenError':
      return new DaemonUnreachableError({ cause: error, socketPath });
    case 'SocketWriteError':
    case 'SocketReadError':
    case 'SocketCloseError':
      return new ConnectionClosedError({ received: [], socketPath });
    default: {
      const exhaustive: never = error.reason;
      return exhaustive;
    }
  }
};

const passthrough = (options: RunExecOptions): Effect.Effect<RunExecResult> =>
  Effect.gen(function* () {
    options.io.writeStderr(formatProgressLine({ kind: 'passthrough', reason: 'daemon unreachable' }));
    const killSignal = yield* Deferred.make<void>();
    const result = yield* executeCargo({
      argv: options.argv,
      cwd: options.cwd,
      env: options.env,
      killSignal,
      onOutput: (channel, data) => Effect.sync(() => writeChannel(options.io, channel, data)),
      tailBytes: 0,
    });
    return {
      exitCode: result.exitCode ?? 1,
      mode: 'passthrough' as const,
    };
  }).pipe(Effect.provide(NodeServices.layer));

const handleServerMessage = (
  options: RunExecOptions,
  message: ServerMessage,
  ticket: Ref.Ref<string | null>,
  phase: Ref.Ref<'queued' | 'running'>,
  finished: Deferred.Deferred<RunExecResult>,
  detach: (ticket: string) => Effect.Effect<void>,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    switch (message.type) {
      case 'ack':
        yield* Ref.set(ticket, message.ticket);
        options.io.writeStderr(
          message.attachedTo !== undefined
            ? formatProgressLine({
                kind: 'attached',
                leaderTicket: message.attachedTo,
                mode: message.attachMode ?? 'identity',
                ticket: message.ticket,
              })
            : formatProgressLine({
                kind: 'queued',
                laneKey: message.laneKey,
                position: message.position,
                ticket: message.ticket,
                ...(message.etaMs === undefined ? {} : { etaMs: message.etaMs }),
              }),
        );
        const autoBackground =
          options.background !== true &&
          message.etaMs !== undefined &&
          shouldAutoBackground(message.etaMs, options.host);
        if (options.background === true || autoBackground) {
          options.io.writeStderr(
            formatProgressLine({
              estimateMs: message.etaMs ?? null,
              kind: 'background',
              ticket: message.ticket,
            }),
          );
          if (autoBackground) {
            yield* detach(message.ticket);
          }
          yield* Deferred.succeed(finished, {
            exitCode: 0,
            mode: 'brokered' as const,
            ticket: message.ticket,
          });
        }
        return;
      case 'requeued':
        yield* Ref.set(phase, 'queued');
        options.io.writeStderr(
          formatProgressLine({ kind: 'requeued', reason: message.reason, ticket: message.ticket }),
        );
        return;
      case 'started':
        yield* Ref.set(ticket, message.ticket);
        yield* Ref.set(phase, 'running');
        options.io.writeStderr(
          formatProgressLine({ kind: 'started', ticket: message.ticket, waitMs: message.waitMs }),
        );
        return;
      case 'output':
        writeChannel(options.io, message.channel, Buffer.from(message.data, 'base64'));
        return;
      case 'exit':
        yield* Ref.set(ticket, message.ticket);
        yield* Deferred.succeed(finished, {
          exitCode: message.exitCode === null ? 1 : message.exitCode,
          mode: 'brokered' as const,
          ticket: message.ticket,
        });
        return;
      case 'error':
        options.io.writeStderr(`[cargo-conductor] ${message.message}\n`);
        yield* Deferred.succeed(finished, {
          exitCode: message.code === 'bad-intent' ? 2 : 1,
          mode: 'brokered' as const,
        });
        return;
      case 'kill-result':
      case 'pong':
      case 'status-result':
      case 'shutting-down':
      case 'detach-result':
      case 'await-result':
      case 'result-result':
      case 'session-pending-result':
      case 'session-completed-result':
        return;
      default: {
        const exhaustive: never = message;
        return exhaustive;
      }
    }
  });

const streamBrokered = (
  options: RunExecOptions,
  config: DaemonConfigShape,
): Effect.Effect<RunExecResult, DaemonUnreachableError | ConnectionClosedError, Scope> =>
  Effect.gen(function* () {
    const received: ServerMessage[] = [];
    const lines = new LineBuffer();
    const opened = yield* Deferred.make<void>();
    const finished = yield* Deferred.make<RunExecResult>();
    const ticket = yield* Ref.make<string | null>(null);
    const phase = yield* Ref.make<'queued' | 'running'>('queued');
    const submittedAtMs = Date.now();
    const id = shortId();

    // v4 sockets connect lazily: open failures surface through the pump's
    // `socket.run`, which routes them via mapOpenError below.
    const socket = yield* NodeSocket.makeNet({
      openTimeout: 2_000,
      path: config.socketPath,
    });

    const write = yield* socket.writer;

    const afterDisconnect = (): Effect.Effect<
      RunExecResult,
      DaemonUnreachableError | ConnectionClosedError
    > =>
      Deferred.isDone(finished).pipe(
        Effect.flatMap((done) =>
          done
            ? Deferred.await(finished)
            : Effect.fail(
                new ConnectionClosedError({
                  received,
                  socketPath: config.socketPath,
                }),
              ),
        ),
      );

    const pump = socket
      .run(
        (data) =>
          Effect.gen(function* () {
            for (const line of lines.push(data)) {
              const message = parseServerMessageLine(line);
              received.push(message);
              yield* handleServerMessage(options, message, ticket, phase, finished, (target) =>
                write(encodeClientMessage({ type: 'detach', id: `${id}-detach`, ticket: target })).pipe(
                  Effect.ignore,
                ),
              );
            }
          }),
        { onOpen: Deferred.succeed(opened, undefined).pipe(Effect.asVoid) },
      )
      .pipe(
        Effect.matchEffect({
          onFailure: (
            error,
          ): Effect.Effect<RunExecResult, DaemonUnreachableError | ConnectionClosedError> => {
            const mapped = mapOpenError(error, config.socketPath);
            switch (mapped._tag) {
              case 'DaemonUnreachable':
                return Effect.fail(mapped);
              case 'ConnectionClosed':
                return afterDisconnect();
              default: {
                const exhaustive: never = mapped;
                return exhaustive;
              }
            }
          },
          onSuccess: () => afterDisconnect(),
        }),
      );

    const pumpFiber = yield* Effect.forkScoped(pump);
    yield* Deferred.await(opened).pipe(Effect.raceFirst(Fiber.join(pumpFiber)));

    yield* write(
      encodeClientMessage({
        type: 'exec',
        id,
        argv: [...options.argv],
        cwd: options.cwd,
        ...(options.env === undefined ? {} : { env: { ...options.env } }),
        ...(options.host === undefined ? {} : { host: options.host }),
        ...(options.session === undefined ? {} : { session: options.session }),
        ...(options.workspaceRoot === undefined ? {} : { workspaceRoot: options.workspaceRoot }),
        ...(options.background === true ? { background: true } : {}),
      }),
    ).pipe(Effect.mapError((error) => mapOpenError(error, config.socketPath)));

    const heartbeatMs = options.heartbeatMs ?? defaultHeartbeatMs;
    yield* Effect.forkScoped(
      Effect.repeat(
        Effect.gen(function* () {
          const currentTicket = yield* Ref.get(ticket);
          if (currentTicket === null) {
            return;
          }
          const currentPhase = yield* Ref.get(phase);
          options.io.writeStderr(
            formatProgressLine({
              elapsedMs: Date.now() - submittedAtMs,
              kind: 'heartbeat',
              phase: currentPhase,
              ticket: currentTicket,
            }),
          );
        }),
        Schedule.spaced(heartbeatMs),
      ),
    );

    return yield* Deferred.await(finished).pipe(Effect.raceFirst(Fiber.join(pumpFiber)));
  });

const brokeredOrUnreachable = (
  options: RunExecOptions,
  config: DaemonConfigShape,
): Effect.Effect<RunExecResult, DaemonUnreachableError> =>
  Effect.scoped(streamBrokered(options, config)).pipe(
    Effect.catchTag('ConnectionClosed', (closed) => {
      const exit = closed.received.find((message): message is ExitMessage => message.type === 'exit');
      if (exit !== undefined) {
        return Effect.succeed({
          exitCode: exit.exitCode === null ? 1 : exit.exitCode,
          mode: 'brokered' as const,
          ticket: exit.ticket,
        });
      }
      if (closed.received.length === 0) {
        return Effect.fail(new DaemonUnreachableError({ cause: closed, socketPath: config.socketPath }));
      }
      return Effect.succeed({ exitCode: 1, mode: 'brokered' as const });
    }),
  );

export const runExecClient = (
  options: RunExecOptions,
): Effect.Effect<RunExecResult> => {
  const config = options.config ?? resolveDaemonConfig();
  return brokeredOrUnreachable(options, config).pipe(
    Effect.catchTag('DaemonUnreachable', () =>
      Effect.gen(function* () {
        if (options.autoSpawn === false) {
          return yield* passthrough(options);
        }
        const ensure = options.ensureDaemon ?? (() => ensureDaemonRunning(config).pipe(Effect.asVoid));
        yield* ensure().pipe(Effect.ignore);
        return yield* brokeredOrUnreachable(options, config).pipe(
          Effect.catchTag('DaemonUnreachable', () => passthrough(options)),
        );
      }),
    ),
  );
};
