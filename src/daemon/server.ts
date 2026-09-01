import type * as Socket from '@effect/platform/Socket';
import * as Deferred from 'effect/Deferred';
import * as Effect from 'effect/Effect';
import * as Queue from 'effect/Queue';
import * as Ref from 'effect/Ref';
import type * as Scope from 'effect/Scope';

import type { BrokerApi } from './broker.js';
import type { ClientMessage, ExecRequest, ServerMessage } from './protocol.js';
import { LineBuffer, clientMessageSchema, encodeServerMessage } from './protocol.js';

export interface ConnectionHandlerOptions {
  readonly broker: BrokerApi;
  readonly shutdownLatch: Deferred.Deferred<void>;
  readonly startedAtMs: number;
  readonly version: string;
}

const extractId = (value: unknown): string | null => {
  if (typeof value === 'object' && value !== null && 'id' in value) {
    const id = (value as { readonly id: unknown }).id;
    return typeof id === 'string' ? id : null;
  }
  return null;
};

/**
 * One fiber per connection. Inbound lines are dispatched off the read pump
 * (exec submissions fork) so a long build never blocks kill/status messages
 * arriving on the same socket. Outbound messages flow through a queue with a
 * single writer fiber, keeping NDJSON lines whole under concurrency.
 */
export const makeConnectionHandler =
  (options: ConnectionHandlerOptions) =>
  (socket: Socket.Socket): Effect.Effect<void> =>
    Effect.scoped(
      Effect.gen(function* () {
        const write = yield* socket.writer;
        const outbound = yield* Queue.unbounded<ServerMessage>();
        const closed = yield* Ref.make(false);
        const ownTickets = new Set<string>();

        // Jobs outlive connections by design (results stay retrievable from
        // the ledger), so sends become no-ops once the peer is gone. The
        // outbound queue is never shut down: offers to a shutdown queue
        // interrupt the offering fiber, which must never happen to a lane
        // worker delivering output.
        const send = (message: ServerMessage): Effect.Effect<void> =>
          Effect.gen(function* () {
            const isClosed = yield* Ref.get(closed);
            if (!isClosed) {
              yield* Queue.offer(outbound, message);
            }
          });

        yield* Effect.fork(
          Effect.forever(
            Effect.gen(function* () {
              const message = yield* Queue.take(outbound);
              yield* write(encodeServerMessage(message));
            }),
          ).pipe(Effect.catchAllCause(() => Ref.set(closed, true))),
        );

        const handleExec = (message: ExecRequest): Effect.Effect<void> =>
          Effect.gen(function* () {
            const submitted = yield* Effect.either(
              options.broker.submit(
                {
                  argv: message.argv,
                  cwd: message.cwd,
                  workspaceRoot: message.workspaceRoot,
                  env: message.env,
                  session: message.session,
                  host: message.host,
                },
                {
                  onStarted: (info) =>
                    send({ type: 'started', id: message.id, ticket: info.ticket, waitMs: info.waitMs }),
                  onOutput: (info) =>
                    send({
                      type: 'output',
                      id: message.id,
                      ticket: info.ticket,
                      channel: info.channel,
                      data: Buffer.from(info.data).toString('base64'),
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
                },
              ),
            );
            if (submitted._tag === 'Left') {
              yield* send({
                type: 'error',
                id: message.id,
                code: 'bad-intent',
                message: submitted.left.message,
              });
              return;
            }
            yield* Effect.sync(() => ownTickets.add(submitted.right.ticket));
            yield* send({
              type: 'ack',
              id: message.id,
              ticket: submitted.right.ticket,
              laneKey: submitted.right.laneKey,
              position: submitted.right.position,
            });
          });

        const handleMessage = (message: ClientMessage): Effect.Effect<void, never, Scope.Scope> => {
          switch (message.type) {
            case 'exec':
              return Effect.asVoid(Effect.forkScoped(handleExec(message)));
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
            case 'shutdown':
              // Written directly (not via the queue) so the ack is flushed
              // before the latch tears the server down.
              return write(encodeServerMessage({ type: 'shutting-down', id: message.id })).pipe(
                Effect.ignore,
                Effect.zipRight(Deferred.succeed(options.shutdownLatch, undefined)),
                Effect.asVoid,
              );
            default: {
              const exhaustive: never = message;
              return Effect.dieMessage(`Unhandled client message: ${String(exhaustive)}`);
            }
          }
        };

        const handleLine = (line: string): Effect.Effect<void, never, Scope.Scope> =>
          Effect.gen(function* () {
            let json: unknown;
            try {
              json = JSON.parse(line);
            } catch (cause) {
              yield* send({
                type: 'error',
                id: null,
                code: 'bad-message',
                message: `invalid JSON line: ${cause instanceof Error ? cause.message : String(cause)}`,
              });
              return;
            }
            const parsed = clientMessageSchema.safeParse(json);
            if (!parsed.success) {
              yield* send({
                type: 'error',
                id: extractId(json),
                code: 'bad-message',
                message: parsed.error.message,
              });
              return;
            }
            yield* handleMessage(parsed.data);
          });

        const lineBuffer = new LineBuffer();
        yield* socket
          .run((chunk) => Effect.forEach(lineBuffer.push(chunk), handleLine, { discard: true }))
          .pipe(
            // Abrupt disconnects are routine (agent shells die mid-build).
            Effect.catchAll(() => Effect.void),
            Effect.ensuring(
              Effect.gen(function* () {
                yield* Ref.set(closed, true);
                // Queued-but-unstarted work from a dead client is abandoned;
                // running work continues so its result lands in the ledger.
                yield* Effect.forEach(
                  [...ownTickets],
                  (ticket) => options.broker.kill(ticket, { onlyIfQueued: true }),
                  { discard: true },
                );
              }),
            ),
          );
      }),
    );
