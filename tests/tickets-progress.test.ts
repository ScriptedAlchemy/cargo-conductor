import { describe, expect, it } from 'effect-rstest';
import * as Effect from 'effect/Effect';

import { runExecClient } from '../src/client/exec.js';
import {
  awaitTicket,
  awaitTicketWithProgress,
  fetchTicket,
  submitBackground,
} from '../src/client/tickets.js';
import { awaitCeilingMs } from '../src/daemon/protocol.js';

import { fakeCargoEnv, scopedDaemon, scopedEnv } from './harness.js';

const silentIo = {
  writeStderr: () => undefined,
  writeStdout: () => undefined,
};

describe('awaitTicketWithProgress', () => {
  it.live('emits heartbeat lines while waiting and resolves with the finished record', () =>
    Effect.gen(function* () {
      const fixture = yield* scopedDaemon(5);
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
        ({ line }) => {
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
    }));

  it.live('suppresses a transient failed poll after the ticket has been observed', () =>
    Effect.gen(function* () {
      const fixture = yield* scopedDaemon(5);
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
        ({ line }) => {
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
    }));
});

describe('awaitTicket', () => {
  it.live('fails fast on a daemon error reply instead of waiting out the full timeout', () =>
    Effect.gen(function* () {
      const fixture = yield* scopedDaemon(5);
      const startedAt = Date.now();
      // Over the wire ceiling: the daemon answers `error` with this request's
      // id at once; the client used to wait maxWaitMs + 2 s for an
      // `await-result` that would never come.
      const error = yield* Effect.flip(awaitTicket('cc-1', awaitCeilingMs + 1, fixture.config));
      expect(error._tag).toBe('DaemonRejected');
      expect(Date.now() - startedAt).toBeLessThan(5_000);
    }));
});

describe('submitBackground', () => {
  it.live('does not hold the stop hook, like exec --bg with the same session', () =>
    Effect.gen(function* () {
      const fixture = yield* scopedDaemon(5);
      // `request` ships no caller env: the in-process daemon must find the
      // fake cargo through its own environment.
      yield* scopedEnv({ CARGO_HAULER_CARGO_BIN: `${fixture.binDir}/cargo` });
      const viaRequest = yield* submitBackground(
        { argv: ['cargo', 'build', '-p', 'via-request'], cwd: fixture.ws1, session: 's1' },
        fixture.config,
      );
      const viaExec = yield* runExecClient({
        argv: ['cargo', 'build', '-p', 'via-exec'],
        autoSpawn: false,
        background: true,
        config: fixture.config,
        cwd: fixture.ws1,
        env: fakeCargoEnv(fixture),
        io: silentIo,
        session: 's1',
      });
      const [requested, executed] = yield* Effect.all([
        fetchTicket(viaRequest ?? '', fixture.config),
        fetchTicket(viaExec.ticket ?? '', fixture.config),
      ]);
      // Background tickets never hold a stop; the two entry points used to
      // disagree, so `hauler request --session` blocked the agent's stop.
      expect(requested?.holdStop).toBe(false);
      expect(executed?.holdStop).toBe(false);
    }));
});
