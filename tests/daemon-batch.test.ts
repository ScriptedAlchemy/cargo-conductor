import { describe, expect, it } from '@rstest/core';
import * as Effect from 'effect/Effect';

import { decodeOutput, execRequest, findExit, pollReport, withDaemon } from './harness.js';

describe('batch composer', () => {
  it('merges two queued scoped checks into one cargo invocation', () =>
    withDaemon(1, (fixture) =>
      Effect.gen(function* () {
        yield* execRequest(fixture, {
          cwd: fixture.ws1,
          isTerminal: (message) => message.type === 'started',
          sleep: '0.3',
        });
        const [alpha, beta] = yield* Effect.all(
          [
            execRequest(fixture, {
              argv: ['cargo', 'check', '-p', 'alpha'],
              cwd: fixture.ws1,
            }),
            execRequest(fixture, {
              argv: ['cargo', 'check', '-p', 'beta'],
              cwd: fixture.ws1,
            }),
          ],
          { concurrency: 'unbounded' },
        );
        const alphaExit = findExit(alpha);
        const betaExit = findExit(beta);
        expect(alphaExit.status).toBe('done');
        expect(betaExit.status).toBe('done');
        const report = yield* pollReport(fixture, (candidate) =>
          [alphaExit.ticket, betaExit.ticket].every((ticket) =>
            candidate.recent.some((record) => record.ticket === ticket && record.status === 'done'),
          ),
        );
        const alphaRecord = report.recent.find((record) => record.ticket === alphaExit.ticket);
        const betaRecord = report.recent.find((record) => record.ticket === betaExit.ticket);
        const attached =
          alphaRecord?.attachedTo === betaExit.ticket || betaRecord?.attachedTo === alphaExit.ticket;
        expect(attached).toBe(true);
        expect(
          alphaRecord?.attachMode === 'batch' || betaRecord?.attachMode === 'batch',
        ).toBe(true);
        const leaderOutput = `${decodeOutput(alpha, 'stdout')}${decodeOutput(beta, 'stdout')}`;
        expect(leaderOutput.includes('-p') || attached).toBe(true);
      }),
    ));
});
