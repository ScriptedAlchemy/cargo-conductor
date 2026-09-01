import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from '@rstest/core';
import * as Effect from 'effect/Effect';

import { execRequest, findExit, pollReport, withDaemon } from './harness.js';

const fixtureWorkspace = join(dirname(fileURLToPath(import.meta.url)), '..', 'evals', 'fixture');

describe('cargo-hauler evals', () => {
  it('coalesces identical checks against the fixture workspace into one execution', () =>
    withDaemon(5, (fixture) =>
      Effect.gen(function* () {
        const [first, second] = yield* Effect.all(
          [
            execRequest(fixture, {
              argv: ['cargo', 'check', '-p', 'alpha'],
              cwd: fixtureWorkspace,
              sleep: '0.2',
            }),
            execRequest(fixture, {
              argv: ['cargo', 'check', '-p', 'alpha'],
              cwd: fixtureWorkspace,
            }),
          ],
          { concurrency: 'unbounded' },
        );
        const firstExit = findExit(first);
        const secondExit = findExit(second);
        expect(firstExit.status).toBe('done');
        expect(secondExit.status).toBe('done');
        const report = yield* pollReport(fixture, (candidate) =>
          candidate.recent.some((record) => record.ticket === secondExit.ticket && record.status === 'done'),
        );
        const follower = report.recent.find((record) => record.ticket === secondExit.ticket);
        expect(follower?.attachedTo === firstExit.ticket || follower?.attachMode === 'identity').toBe(
          true,
        );
      }),
    ));
});
