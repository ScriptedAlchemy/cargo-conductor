import { describe, expect, it } from 'effect-rstest';
import * as Effect from 'effect/Effect';
import * as Fiber from 'effect/Fiber';

import { execRequest, findExit, pollReport, scopedDaemon } from './harness.js';

describe('lane scheduler', () => {
  it.live('runs a cheap fmt ahead of a queued workspace-sized build after the holder finishes', () =>
    Effect.gen(function* () {
      const fixture = yield* scopedDaemon(1);
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
    }));
});

describe('surface affinity', () => {
  it.live('runs the request on the surface the lane just built ahead of an older one that would switch', () =>
    Effect.gen(function* () {
      const fixture = yield* scopedDaemon(1);
      // The holder builds with feature `alpha`; while it runs, a request
      // without the feature arrives first and one with it arrives second.
      // Both carry the same default estimate, so only affinity separates them.
      yield* execRequest(fixture, {
        argv: ['cargo', 'check', '-p', 'holder', '--features', 'alpha'],
        cwd: fixture.ws1,
        isTerminal: (message) => message.type === 'started',
        sleep: '0.5',
      });
      const switchingFiber = yield* Effect.forkChild(
        execRequest(fixture, { argv: ['cargo', 'check', '-p', 'plain'], cwd: fixture.ws1 }),
      );
      yield* Effect.sleep('40 millis');
      const affineFiber = yield* Effect.forkChild(
        execRequest(fixture, {
          argv: ['cargo', 'check', '-p', 'featured', '--features', 'alpha'],
          cwd: fixture.ws1,
        }),
      );
      const [switchingMessages, affineMessages] = yield* Effect.all([
        Fiber.join(switchingFiber),
        Fiber.join(affineFiber),
      ]);
      const switching = findExit(switchingMessages);
      const affine = findExit(affineMessages);
      const report = yield* pollReport(fixture, (candidate) =>
        [switching.ticket, affine.ticket].every((ticket) =>
          candidate.recent.some((record) => record.ticket === ticket && record.status === 'done'),
        ),
      );
      const startedAt = (ticket: string) =>
        report.recent.find((record) => record.ticket === ticket)?.startedAtMs ?? Number.NaN;
      expect(startedAt(affine.ticket)).toBeLessThan(startedAt(switching.ticket));
    }));
});
