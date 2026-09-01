import { describe, expect, it } from '@rstest/core';
import * as Effect from 'effect/Effect';

import { requestOverSocket } from '../src/daemon/control.js';
import type { AckMessage, AwaitResultMessage, ResultResultMessage } from '../src/daemon/protocol.js';
import { pollReport, shortId, withDaemon } from './harness.js';

describe('async tickets', () => {
  it('keeps a background request after the client disconnects and serves await/result', () =>
    withDaemon(5, (fixture) =>
      Effect.gen(function* () {
        const ackMessages = yield* requestOverSocket({
          isTerminal: (message) => message.type === 'ack' || message.type === 'error',
          message: {
            argv: ['cargo', 'check', '-p', 'bg-probe'],
            background: true,
            cwd: fixture.ws1,
            env: {
              FAKE_SLEEP: '0.2',
              PATH: `${fixture.binDir}:${process.env.PATH ?? ''}`,
            },
            id: shortId(),
            session: 'sess-bg',
            type: 'exec',
          },
          socketPath: fixture.config.socketPath,
        });
        const ack = ackMessages.find((message): message is AckMessage => message.type === 'ack');
        expect(ack?.ticket).toMatch(/^cc-\d+$/u);
        const ticket = ack?.ticket ?? '';

        const report = yield* pollReport(
          fixture,
          (candidate) =>
            candidate.recent.find((record) => record.ticket === ticket)?.status === 'done',
        );
        expect(report.recent.find((record) => record.ticket === ticket)?.status).toBe('done');

        const resultMessages = yield* requestOverSocket({
          isTerminal: (message) => message.type === 'result-result',
          message: { id: shortId(), ticket, type: 'result' },
          socketPath: fixture.config.socketPath,
        });
        const result = resultMessages.find(
          (message): message is ResultResultMessage => message.type === 'result-result',
        );
        expect(result?.request?.status).toBe('done');

        const awaited = yield* requestOverSocket({
          isTerminal: (message) => message.type === 'await-result',
          message: { id: shortId(), maxWaitMs: 1_000, ticket, type: 'await' },
          socketPath: fixture.config.socketPath,
        });
        const awaitResult = awaited.find(
          (message): message is AwaitResultMessage => message.type === 'await-result',
        );
        expect(awaitResult?.timedOut).toBe(false);
        expect(awaitResult?.request?.ticket).toBe(ticket);
      }),
    ));
});
