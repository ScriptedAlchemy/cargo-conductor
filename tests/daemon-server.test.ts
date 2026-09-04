import { describe, expect, it } from 'effect-rstest';
import * as Socket from 'effect/unstable/socket/Socket';
import * as Deferred from 'effect/Deferred';
import * as Effect from 'effect/Effect';

import type { BrokerApi } from '../src/daemon/broker.js';
import type { OutputMessage, ServerMessage } from '../src/daemon/protocol.js';
import { ConnectionOutputBuffer, makeConnectionHandler } from '../src/daemon/server.js';

const brokerWith = (overrides: Partial<BrokerApi> = {}): BrokerApi => ({
  _testWaiterCount: () => Effect.succeed(0),
  awaitTicket: () => Effect.succeed({ record: null, timedOut: false }),
  detach: () => Effect.succeed(true),
  getTicket: () => Effect.succeed(null),
  kill: () => Effect.succeed(true),
  recordAttempt: () => Effect.succeed({ ticket: 'cc-attempt' }),
  report: () => Effect.die(new Error('status exploded')),
  sessionCompleted: () => Effect.succeed([]),
  sessionPending: () => Effect.succeed([]),
  submit: () => Effect.die(new Error('unexpected submit')),
  ...overrides,
});

const runMessages = (messages: readonly string[], broker: BrokerApi) =>
  Effect.gen(function* () {
    const written = yield* Deferred.make<void>();
    const replies: ServerMessage[] = [];
    const socket = {
      [Socket.TypeId]: Socket.TypeId,
      writer: Effect.succeed((chunk: Uint8Array | string) =>
        Effect.sync(() => {
          const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
          for (const line of text.split('\n')) {
            if (line.length > 0) {
              replies.push(JSON.parse(line) as ServerMessage);
            }
          }
        }).pipe(Effect.andThen(Deferred.succeed(written, undefined)), Effect.asVoid),
      ),
      run: (handler: (chunk: Uint8Array) => Effect.Effect<unknown> | void) =>
        Effect.gen(function* () {
          const handled = handler(Buffer.from(messages.join('')));
          if (Effect.isEffect(handled)) {
            yield* handled;
          }
          yield* Deferred.await(written).pipe(Effect.timeout('500 millis'));
        }),
      runRaw: () => Effect.void,
    } as unknown as Socket.Socket;
    const shutdownLatch = yield* Deferred.make<void>();
    yield* makeConnectionHandler({
      broker,
      shutdownLatch,
      startedAtMs: 0,
      version: 'test',
    })(socket);
    return replies;
  });

const output = (sequence: number): OutputMessage => ({
  type: 'output',
  id: 'exec-1',
  ticket: 'cc-1',
  channel: 'stdout',
  data: Buffer.from(`chunk-${sequence}-${'x'.repeat(32)}`).toString('base64'),
});

describe('daemon connection output buffering', () => {
  it('bounds a slow reader while retaining control messages and a truncation notice', () => {
    const buffer = new ConnectionOutputBuffer({
      maxOutputBytes: 256,
      maxOutputMessages: 4,
    });
    buffer.offer({ type: 'started', id: 'exec-1', ticket: 'cc-1', waitMs: 0 });
    for (let sequence = 0; sequence < 100; sequence += 1) {
      buffer.offer(output(sequence));
    }
    buffer.offer({
      type: 'exit',
      id: 'exec-1',
      ticket: 'cc-1',
      status: 'done',
      exitCode: 0,
      signal: null,
      waitMs: 0,
      runMs: 1,
      error: null,
    });

    expect(buffer.bufferedOutputMessages).toBeLessThanOrEqual(4);
    expect(buffer.bufferedOutputBytes).toBeLessThanOrEqual(256);

    const drained: ServerMessage[] = [];
    for (let message = buffer.take(); message !== null; message = buffer.take()) {
      drained.push(message);
    }
    expect(drained[0]?.type).toBe('started');
    expect(drained.at(-1)?.type).toBe('exit');
    const notices = drained.filter(
      (message): message is OutputMessage =>
        message.type === 'output' &&
        Buffer.from(message.data, 'base64').toString('utf8').includes('output truncated'),
    );
    expect(notices).toHaveLength(1);
    expect(Buffer.from(notices[0]?.data ?? '', 'base64').toString('utf8')).toContain(
      'slow client',
    );
  });

  it('drains every currently queued message in FIFO order', () => {
    const buffer = new ConnectionOutputBuffer();
    buffer.offer({ type: 'started', id: 'exec-1', ticket: 'cc-1', waitMs: 0 });
    buffer.offer(output(1));
    buffer.offer({
      type: 'exit',
      id: 'exec-1',
      ticket: 'cc-1',
      status: 'done',
      exitCode: 0,
      signal: null,
      waitMs: 0,
      runMs: 1,
      error: null,
    });

    expect(buffer.drain().map((message) => message.type)).toEqual(['started', 'output', 'exit']);
    expect(buffer.size).toBe(0);
    expect(buffer.bufferedOutputBytes).toBe(0);
    expect(buffer.bufferedOutputMessages).toBe(0);
  });
});

describe('daemon connection detach', () => {
  it.live('marks the ticket detached in the ledger so the afterTool hook reports it', () =>
    Effect.gen(function* () {
      const detached: string[] = [];
      const replies = yield* runMessages(
        [`${JSON.stringify({ type: 'detach', id: 'detach-1', ticket: 'cc-9' })}\n`],
        brokerWith({
          detach: (ticket) =>
            Effect.sync(() => {
              detached.push(ticket);
              return true;
            }),
        }),
      );

      expect(detached).toEqual(['cc-9']);
      // `detached` reports whether this connection owned the ticket; a detach
      // for a ticket it never streamed is still recorded but answers false.
      expect(replies).toContainEqual({ type: 'detach-result', id: 'detach-1', ticket: 'cc-9', detached: false });
    }));
});

describe('daemon connection defect boundaries', () => {
  it.live('sends an internal error reply when an inline handler defects', () =>
    Effect.gen(function* () {
      const replies = yield* runMessages(
        [`${JSON.stringify({ type: 'status', id: 'status-1' })}\n`],
        brokerWith(),
      );

      expect(replies).toContainEqual({
        type: 'error',
        id: 'status-1',
        code: 'internal',
        message: 'internal daemon error',
      });
    }));

  it.live('sends an internal error reply when a forked await handler defects', () =>
    Effect.gen(function* () {
      const replies = yield* runMessages(
        [
          `${JSON.stringify({
            type: 'await',
            id: 'await-1',
            ticket: 'cc-1',
            maxWaitMs: 1_000,
          })}\n`,
        ],
        brokerWith({
          awaitTicket: () => Effect.die(new Error('await exploded')),
        }),
      );

      expect(replies).toContainEqual({
        type: 'error',
        id: 'await-1',
        code: 'internal',
        message: 'internal daemon error',
      });
    }));

  it.live('sends an internal error reply when a forked exec handler defects', () =>
    Effect.gen(function* () {
      const replies = yield* runMessages(
        [
          `${JSON.stringify({
            type: 'exec',
            id: 'exec-1',
            argv: ['cargo', 'check'],
            cwd: '/tmp/workspace',
          })}\n`,
        ],
        brokerWith(),
      );

      expect(replies).toContainEqual({
        type: 'error',
        id: 'exec-1',
        code: 'internal',
        message: 'internal daemon error',
      });
    }));

  it.live('writes broker-encoded output bytes without encoding them again', () =>
    Effect.gen(function* () {
      const encoded = Buffer.from('identical follower bytes\n').toString('base64');
      const replies = yield* runMessages(
        [
          `${JSON.stringify({
            type: 'exec',
            id: 'exec-encoded',
            argv: ['cargo', 'check'],
            cwd: '/tmp/workspace',
          })}\n`,
        ],
        brokerWith({
          submit: (_input, callbacks) =>
            callbacks
              .onOutput({ channel: 'stdout', data: encoded, ticket: 'cc-1' })
              .pipe(
                Effect.as({
                  laneKey: 'lane',
                  position: 0,
                  ticket: 'cc-1',
                }),
              ),
        }),
      );

      const message = replies.find(
        (candidate): candidate is OutputMessage => candidate.type === 'output',
      );
      expect(message?.data).toBe(encoded);
      expect(Buffer.from(message?.data ?? '', 'base64').toString('utf8')).toBe(
        'identical follower bytes\n',
      );
    }));

  it.live('handles kill promptly while await is pending on the same connection', () =>
    Effect.gen(function* () {
      const replies = yield* runMessages(
        [
          `${JSON.stringify({
            type: 'await',
            id: 'await-1',
            ticket: 'cc-1',
            maxWaitMs: 900_000,
          })}\n`,
          `${JSON.stringify({ type: 'kill', id: 'kill-1', ticket: 'cc-1' })}\n`,
        ],
        brokerWith({
          awaitTicket: () => Effect.never,
          report: () => Effect.die(new Error('unexpected report')),
        }),
      );

      expect(replies).toContainEqual({
        type: 'kill-result',
        id: 'kill-1',
        ticket: 'cc-1',
        killed: true,
      });
    }));
});
