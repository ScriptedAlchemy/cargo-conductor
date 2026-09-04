import { randomUUID } from 'node:crypto';

import * as Cause from 'effect/Cause';
import * as Deferred from 'effect/Deferred';
import * as Effect from 'effect/Effect';
import * as Queue from 'effect/Queue';
import * as Result from 'effect/Result';
import type * as Scope from 'effect/Scope';
import type * as Socket from 'effect/unstable/socket/Socket';

import { isRecord } from '../lib/guards.js';

import type { BrokerApi } from './broker.js';
import type {
  ClientMessage,
  ExecRequest,
  OutputMessage,
  ServerMessage,
} from './protocol.js';
import { LineBuffer, clientMessageSchema, encodeServerMessage } from './protocol.js';

export interface ConnectionHandlerOptions {
  readonly broker: BrokerApi;
  readonly shutdownLatch: Deferred.Deferred<void>;
  readonly startedAtMs: number;
  readonly version: string;
}

export interface ConnectionOutputBufferOptions {
  readonly maxOutputBytes: number;
  readonly maxOutputMessages: number;
}

interface BufferedServerMessage {
  message: ServerMessage;
  outputBytes: number;
}

const defaultOutputBufferOptions: ConnectionOutputBufferOptions = {
  maxOutputBytes: 1024 * 1024,
  maxOutputMessages: 128,
};

/**
 * FIFO connection buffer with a bounded bulk-output portion. Control and
 * terminal messages are always retained; overflow replaces output with one
 * ordinary stderr output message so old clients display the truncation note.
 */
export class ConnectionOutputBuffer {
  readonly #options: ConnectionOutputBufferOptions;
  readonly #pending: BufferedServerMessage[] = [];
  #bufferedOutputBytes = 0;
  #bufferedOutputMessages = 0;
  #droppedPayloadBytes = 0;
  #truncation: BufferedServerMessage | null = null;

  constructor(options: ConnectionOutputBufferOptions = defaultOutputBufferOptions) {
    this.#options = options;
  }

  get bufferedOutputBytes(): number {
    return this.#bufferedOutputBytes;
  }

  get bufferedOutputMessages(): number {
    return this.#bufferedOutputMessages;
  }

  get size(): number {
    return this.#pending.length;
  }

  offer(message: ServerMessage): boolean {
    const wasEmpty = this.#pending.length === 0;
    if (message.type !== 'output') {
      this.#pending.push({ message, outputBytes: 0 });
      return wasEmpty;
    }
    const outputBytes = message.data.length;
    if (
      this.#bufferedOutputMessages < this.#options.maxOutputMessages &&
      this.#bufferedOutputBytes + outputBytes <= this.#options.maxOutputBytes
    ) {
      this.#pending.push({ message, outputBytes });
      this.#bufferedOutputMessages += 1;
      this.#bufferedOutputBytes += outputBytes;
      return wasEmpty;
    }
    this.#recordDrop(message);
    return wasEmpty;
  }

  take(): ServerMessage | null {
    const envelope = this.#pending.shift();
    if (envelope === undefined) {
      return null;
    }
    if (envelope.message.type === 'output') {
      this.#bufferedOutputMessages -= 1;
      this.#bufferedOutputBytes -= envelope.outputBytes;
      if (envelope === this.#truncation) {
        this.#truncation = null;
        this.#droppedPayloadBytes = 0;
      }
    }
    return envelope.message;
  }

  drain(): readonly ServerMessage[] {
    const messages: ServerMessage[] = [];
    for (let message = this.take(); message !== null; message = this.take()) {
      messages.push(message);
    }
    return messages;
  }

  #recordDrop(message: OutputMessage): void {
    this.#droppedPayloadBytes += Buffer.byteLength(message.data, 'base64');
    if (this.#truncation !== null) {
      this.#replaceTruncation(message);
      return;
    }
    while (
      this.#bufferedOutputMessages >= this.#options.maxOutputMessages ||
      this.#bufferedOutputBytes + this.#noticeBytes(message) > this.#options.maxOutputBytes
    ) {
      if (!this.#evictLastOutput()) {
        return;
      }
    }
    const notice = this.#makeNotice(message);
    const envelope = { message: notice, outputBytes: notice.data.length };
    this.#pending.push(envelope);
    this.#bufferedOutputMessages += 1;
    this.#bufferedOutputBytes += envelope.outputBytes;
    this.#truncation = envelope;
  }

  #replaceTruncation(message: OutputMessage): void {
    const truncation = this.#truncation;
    if (truncation === null) {
      return;
    }
    const notice = this.#makeNotice(message);
    this.#bufferedOutputBytes -= truncation.outputBytes;
    truncation.message = notice;
    truncation.outputBytes = notice.data.length;
    this.#bufferedOutputBytes += truncation.outputBytes;
    // The dropped-byte counter grows the notice over time; shed buffered
    // output (never the notice itself) so the swap cannot exceed the byte
    // budget the initial insertion honored.
    while (this.#bufferedOutputBytes > this.#options.maxOutputBytes) {
      if (!this.#evictLastOutput()) {
        return;
      }
    }
  }

  #evictLastOutput(): boolean {
    const index = this.#lastOutputIndex();
    if (index === -1) {
      return false;
    }
    const removed = this.#pending[index];
    if (removed === undefined) {
      return false;
    }
    this.#droppedPayloadBytes +=
      removed.message.type === 'output'
        ? Buffer.byteLength(removed.message.data, 'base64')
        : 0;
    this.#pending.splice(index, 1);
    this.#bufferedOutputMessages -= 1;
    this.#bufferedOutputBytes -= removed.outputBytes;
    return true;
  }

  #noticeBytes(message: OutputMessage): number {
    return this.#makeNotice(message).data.length;
  }

  #makeNotice(message: OutputMessage): OutputMessage {
    return {
      type: 'output',
      id: message.id,
      ticket: message.ticket,
      channel: 'stderr',
      data: Buffer.from(
        `[cargo-hauler] output truncated for slow client: ${this.#droppedPayloadBytes} bytes dropped\n`,
      ).toString('base64'),
    };
  }

  #lastOutputIndex(): number {
    for (let index = this.#pending.length - 1; index >= 0; index -= 1) {
      const envelope = this.#pending[index];
      if (envelope?.message.type === 'output' && envelope !== this.#truncation) {
        return index;
      }
    }
    return -1;
  }
}

const extractId = (value: unknown): string | null => {
  if (!isRecord(value)) {
    return null;
  }
  return typeof value.id === 'string' ? value.id : null;
};

/**
 * One fiber per connection. Inbound lines are dispatched off the read pump
 * (exec submissions and long-poll awaits fork) so suspending work never blocks
 * kill/status messages arriving on the same socket. Outbound messages flow
 * through a queue with a single writer fiber, keeping NDJSON lines whole under
 * concurrency.
 */
export const makeConnectionHandler =
  (options: ConnectionHandlerOptions) =>
  (socket: Socket.Socket): Effect.Effect<void> =>
    Effect.scoped(
      Effect.gen(function* () {
        const write = yield* socket.writer;
        const outbound = new ConnectionOutputBuffer();
        const outboundWake = yield* Queue.dropping<void>(1);
        const connection = { closed: false };
        const ownTickets = new Set<string>();

        // Jobs outlive connections by design (results stay retrievable from
        // the ledger), so sends become no-ops once the peer is gone. The
        // wake queue is never shut down and has dropping capacity one:
        // offers never block or interrupt a lane worker delivering output.
        const send = (message: ServerMessage): Effect.Effect<void> =>
          Effect.uninterruptible(
            Effect.gen(function* () {
              const shouldWake = yield* Effect.sync(() => {
                if (connection.closed) {
                  return false;
                }
                return outbound.offer(message);
              });
              if (shouldWake) {
                yield* Queue.offer(outboundWake, undefined);
              }
            }),
          );

        const recoverHandlerDefect =
          (id: string | null, handler: string) =>
          (cause: Cause.Cause<unknown>): Effect.Effect<void> =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.interrupt
              : Effect.logError(`daemon ${handler} failed`, cause).pipe(
                  Effect.andThen(
                    id === null
                      ? Effect.void
                      : send({
                          type: 'error',
                          id,
                          code: 'internal',
                          message: 'internal daemon error',
                        }),
                  ),
                );

        const takeOutbound = (): Effect.Effect<ServerMessage> =>
          Effect.suspend(() => {
            const message = outbound.take();
            if (message !== null) {
              return Effect.succeed(message);
            }
            return Queue.take(outboundWake).pipe(Effect.andThen(takeOutbound()));
          });

        yield* Effect.forkChild(
          Effect.forever(
            Effect.gen(function* () {
              const message = yield* takeOutbound();
              const batch = [message, ...outbound.drain()];
              yield* write(batch.map(encodeServerMessage).join(''));
            }),
          ).pipe(
            Effect.catchCause(() =>
              Effect.sync(() => {
                connection.closed = true;
              }),
            ),
          ),
        );

        const handleExec = (message: ExecRequest): Effect.Effect<void> =>
          Effect.gen(function* () {
            const submitted = yield* Effect.result(
              options.broker.submit(
                {
                  argv: message.argv,
                  cwd: message.cwd,
                  workspaceRoot: message.workspaceRoot,
                  env: message.env,
                  session: message.session,
                  host: message.host,
                  background: message.background,
                  holdStop: message.holdStop,
                  mergeStderr: message.mergeStderr,
                },
                {
                  onRegistered: (ticket) =>
                    Effect.sync(() => {
                      if (message.background === true) {
                        return true;
                      }
                      if (connection.closed) {
                        return false;
                      }
                      ownTickets.add(ticket);
                      return true;
                    }),
                  onStarted: (info) =>
                    send({ type: 'started', id: message.id, ticket: info.ticket, waitMs: info.waitMs }),
                  onOutput: (info) =>
                    send({
                      type: 'output',
                      id: message.id,
                      ticket: info.ticket,
                      channel: info.channel,
                      data: info.data,
                    }),
                  onExit: (info) =>
                    Effect.gen(function* () {
                      yield* Effect.sync(() => ownTickets.delete(info.ticket));
                      yield* send({
                        type: 'exit',
                        id: message.id,
                        ticket: info.ticket,
                        status: info.status,
                        exitCode: info.exitCode,
                        signal: info.signal,
                        waitMs: info.waitMs,
                        runMs: info.runMs,
                        error: info.error,
                      });
                    }),
                  onRequeued: (info) =>
                    send({
                      type: 'requeued',
                      id: message.id,
                      ticket: info.ticket,
                      reason: info.reason,
                    }),
                },
              ),
            );
            if (submitted._tag === 'Failure') {
              yield* send({
                type: 'error',
                id: message.id,
                code: 'bad-intent',
                message: submitted.failure.message,
              });
              return;
            }
            yield* send({
              type: 'ack',
              id: message.id,
              ticket: submitted.success.ticket,
              laneKey: submitted.success.laneKey,
              position: submitted.success.position,
              ...(submitted.success.attachedTo === undefined
                ? {}
                : { attachedTo: submitted.success.attachedTo }),
              ...(submitted.success.attachMode === undefined
                ? {}
                : { attachMode: submitted.success.attachMode }),
              ...(submitted.success.etaMs === undefined ? {} : { etaMs: submitted.success.etaMs }),
              ...(submitted.success.etaSource === undefined
                ? {}
                : { etaSource: submitted.success.etaSource }),
            });
          });

        const handleMessage = (message: ClientMessage): Effect.Effect<void, never, Scope.Scope> => {
          switch (message.type) {
            case 'exec':
              return Effect.asVoid(
                Effect.forkScoped(
                  handleExec(message).pipe(
                    Effect.catchCause(recoverHandlerDefect(message.id, 'exec handler')),
                  ),
                ),
              );
            case 'attempt':
              return Effect.gen(function* () {
                const recorded = yield* options.broker.recordAttempt({
                  argv: message.argv,
                  cwd: message.cwd,
                  host: message.host,
                  reason: message.reason,
                  session: message.session,
                });
                yield* send({
                  type: 'attempt-recorded',
                  id: message.id,
                  ticket: recorded.ticket,
                });
              });
            case 'kill':
              return Effect.gen(function* () {
                const killed = yield* options.broker.kill(message.ticket);
                yield* send({ type: 'kill-result', id: message.id, ticket: message.ticket, killed });
              });
            case 'status':
              return Effect.gen(function* () {
                const report = yield* options.broker.report(message.limit);
                yield* send({ type: 'status-result', id: message.id, report });
              });
            case 'ping':
              return send({
                type: 'pong',
                id: message.id,
                pid: process.pid,
                startedAtMs: options.startedAtMs,
                version: options.version,
              });
            case 'detach':
              return Effect.gen(function* () {
                const detached = ownTickets.delete(message.ticket);
                // Recorded even when this connection never owned the ticket:
                // the client is telling us nobody will stream its exit.
                yield* options.broker.detach(message.ticket);
                yield* send({
                  type: 'detach-result',
                  id: message.id,
                  ticket: message.ticket,
                  detached,
                });
              });
            case 'await':
              return Effect.asVoid(
                Effect.forkScoped(
                  Effect.gen(function* () {
                    const waited = yield* options.broker.awaitTicket(
                      message.ticket,
                      message.maxWaitMs ?? 30_000,
                    );
                    yield* send({
                      type: 'await-result',
                      id: message.id,
                      request: waited.record,
                      timedOut: waited.timedOut,
                    });
                  }).pipe(
                    Effect.catchCause(recoverHandlerDefect(message.id, 'await handler')),
                  ),
                ),
              );
            case 'result':
              return Effect.gen(function* () {
                const request = yield* options.broker.getTicket(message.ticket);
                yield* send({ type: 'result-result', id: message.id, request });
              });
            case 'session-pending':
              return Effect.gen(function* () {
                const requests = yield* options.broker.sessionPending(message.session);
                yield* send({
                  type: 'session-pending-result',
                  id: message.id,
                  requests,
                });
              });
            case 'session-completed':
              return Effect.gen(function* () {
                const requests = yield* options.broker.sessionCompleted(
                  message.session,
                  message.sinceMs,
                );
                yield* send({
                  type: 'session-completed-result',
                  id: message.id,
                  requests,
                });
              });
            case 'shutdown':
              // Written directly (not via the queue) so the ack is flushed
              // before the latch tears the server down.
              return write(encodeServerMessage({ type: 'shutting-down', id: message.id })).pipe(
                Effect.ignore,
                Effect.andThen(Deferred.succeed(options.shutdownLatch, undefined)),
                Effect.asVoid,
              );
            default: {
              const exhaustive: never = message;
              return Effect.die(new Error(`Unhandled client message: ${String(exhaustive)}`));
            }
          }
        };

        const handleLine = (line: string): Effect.Effect<void, never, Scope.Scope> => {
          let requestId: string | null = null;
          return Effect.gen(function* () {
            const parsedJson = yield* Effect.result(
              Effect.try({
                try: (): unknown => JSON.parse(line),
                catch: (cause) => (cause instanceof Error ? cause.message : String(cause)),
              }),
            );
            if (Result.isFailure(parsedJson)) {
              yield* send({
                type: 'error',
                id: null,
                code: 'bad-message',
                message: `invalid JSON line: ${parsedJson.failure}`,
              });
              return;
            }
            const json = parsedJson.success;
            requestId = extractId(json);
            const parsed = clientMessageSchema.safeParse(json);
            if (!parsed.success) {
              yield* send({
                type: 'error',
                id: requestId,
                code: 'bad-message',
                message: parsed.error.message,
              });
              return;
            }
            requestId = parsed.data.id;
            yield* handleMessage(parsed.data);
          }).pipe(
            Effect.catchCause((cause) =>
              recoverHandlerDefect(requestId, 'connection message handler')(cause),
            ),
          );
        };

        const lineBuffer = new LineBuffer();
        yield* socket
          .run((chunk) => Effect.forEach(lineBuffer.push(chunk), handleLine, { discard: true }))
          .pipe(
            // Abrupt disconnects are routine (agent shells die mid-build).
            Effect.ignore,
            Effect.ensuring(
              Effect.gen(function* () {
                const tickets = yield* Effect.sync(() => {
                  connection.closed = true;
                  return [...ownTickets];
                });
                // Queued-but-unstarted work from a dead client is abandoned;
                // running work continues so its result lands in the ledger.
                yield* Effect.forEach(
                  tickets,
                  (ticket) => options.broker.kill(ticket, { onlyIfQueued: true }),
                  { discard: true },
                );
              }),
            ),
          );
      }),
    ).pipe(Effect.annotateLogs({ connectionId: randomUUID() }));
