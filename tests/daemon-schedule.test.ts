import { describe, expect, it } from '@rstest/core';
import * as Effect from 'effect/Effect';
import * as Fiber from 'effect/Fiber';

import { execRequest, findExit, pollReport, withDaemon } from './harness.js';

describe('lane scheduler', () => {
  it('runs a cheap fmt ahead of a queued workspace-sized build after the holder finishes', () =>
    withDaemon(1, (fixture) =>
      Effect.gen(function* () {
        yield* execRequest(fixture, {
          cwd: fixture.ws1,
          isTerminal: (message) => message.type === 'started',
          sleep: '0.35',
        });
        const buildFiber = yield* Effect.forkChild(
          execRequest(fixture, {
            argv: ['cargo', 'build', '--workspace'],
            cwd: fixture.ws1,
          }),
        );
        yield* Effect.sleep('40 millis');
        const fmtFiber = yield* Effect.forkChild(
          execRequest(fixture, {
            argv: ['cargo', 'fmt'],
            cwd: fixture.ws1,
          }),
        );
        const [buildMessages, fmtMessages] = yield* Effect.all([
          Fiber.join(buildFiber),
          Fiber.join(fmtFiber),
        ]);
        const build = findExit(buildMessages);
        const fmt = findExit(fmtMessages);
        const report = yield* pollReport(
          fixture,
          (candidate) =>
            candidate.recent.some((record) => record.ticket === build.ticket && record.status === 'done') &&
            candidate.recent.some((record) => record.ticket === fmt.ticket && record.status === 'done'),
        );
        const fmtRecord = report.recent.find((record) => record.ticket === fmt.ticket);
        const buildRecord = report.recent.find((record) => record.ticket === build.ticket);
        expect(fmtRecord?.startedAtMs ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(
          buildRecord?.startedAtMs ?? 0,
        );
      }),
    ));
});
