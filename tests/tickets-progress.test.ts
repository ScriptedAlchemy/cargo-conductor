import { describe, expect, it } from '@rstest/core';
import * as Effect from 'effect/Effect';

import { runExecClient } from '../src/client/exec.js';
import { awaitTicketWithProgress, fetchTicket } from '../src/client/tickets.js';

import { withDaemon } from './harness.js';

const silentIo = {
  writeStderr: () => undefined,
  writeStdout: () => undefined,
};

describe('awaitTicketWithProgress', () => {
  it('emits heartbeat lines while waiting and resolves with the finished record', () =>
    withDaemon(5, (fixture) =>
      Effect.gen(function* () {
        const submitted = yield* runExecClient({
          argv: ['cargo', 'build'],
          autoSpawn: false,
          background: true,
          config: fixture.config,
          cwd: fixture.ws1,
          env: {
            CARGO_HAULER_CARGO_BIN: `${fixture.binDir}/cargo`,
            FAKE_SLEEP: '2',
            PATH: `${fixture.binDir}:${process.env.PATH ?? ''}`,
          },
          io: silentIo,
        });
        expect(submitted.ticket).toMatch(/^cc-\d+$/u);
        const ticket = submitted.ticket ?? '';

        const lines: string[] = [];
        const waited = yield* awaitTicketWithProgress(
          ticket,
          30_000,
          (line) => {
            lines.push(line);
          },
          fixture.config,
          250,
        );

        expect(waited.timedOut).toBe(false);
        expect(waited.request?.ticket).toBe(ticket);
        expect(lines.length).toBeGreaterThan(0);
        expect(lines[0]).toContain(ticket);
        // At least one heartbeat renders a live phase with elapsed time
        // rather than silence.
        expect(lines.join('')).toMatch(/(queued|running) \d+m?\d*s/u);
      }),
    ));

  it('suppresses a transient failed poll after the ticket has been observed', () =>
    withDaemon(5, (fixture) =>
      Effect.gen(function* () {
        const submitted = yield* runExecClient({
          argv: ['cargo', 'build', '-p', 'poll-retry'],
          autoSpawn: false,
          background: true,
          config: fixture.config,
          cwd: fixture.ws1,
          env: {
            CARGO_HAULER_CARGO_BIN: `${fixture.binDir}/cargo`,
            FAKE_SLEEP: '0.5',
            PATH: `${fixture.binDir}:${process.env.PATH ?? ''}`,
          },
          io: silentIo,
        });
        const ticket = submitted.ticket ?? '';
        let polls = 0;
        const lines: string[] = [];
        const waited = yield* awaitTicketWithProgress(
          ticket,
          30_000,
          (line) => {
            lines.push(line);
          },
          fixture.config,
          50,
          (target, config) => {
            polls += 1;
            return polls === 2
              ? Effect.fail({ _tag: 'TransientPollFailure' as const })
              : fetchTicket(target, config);
          },
        );

        expect(waited.timedOut).toBe(false);
        expect(polls).toBeGreaterThanOrEqual(3);
        expect(lines.join('')).not.toContain('is not known to the daemon');
        expect(lines.join('')).not.toContain('transient status timeout');
      }),
    ));
});
