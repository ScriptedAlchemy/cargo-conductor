import { describe, expect, it } from 'effect-rstest';
import * as Effect from 'effect/Effect';
import * as Fiber from 'effect/Fiber';

import type { RequestRecord, StatusReport } from '../src/daemon/protocol.js';

import { execRequest, findExit, pollReport, scopedDaemon } from './harness.js';

const runningLeader = (report: StatusReport): RequestRecord | undefined =>
  report.active.find((record) => record.status === 'running' && record.attachedTo === null);

const testArgv = ['cargo', 'test', '-p', 'ws1'];

describe('overrun-aware queue ETA', () => {
  it.live(
    'flags a live overrunning head and keeps a non-zero follower wait ETA',
    () =>
      Effect.gen(function* () {
        const fixture = yield* scopedDaemon(5, {
          CARGO_HAULER_OVERLAP_EXECUTION: '0',
          CARGO_HAULER_STALL_ESTIMATE_FACTOR: '1.5',
        });
        // A short measured run so the next identical test is estimated in
        // hundreds of milliseconds, not the 5-minute cold default.
        const seedExit = findExit(
          yield* execRequest(fixture, {
            argv: testArgv,
            cwd: fixture.ws1,
            sleep: '0.2',
            timeoutMs: 8_000,
          }),
        );
        expect(seedExit.status).toBe('done');

        const leaderFiber = yield* Effect.forkChild(
          execRequest(fixture, {
            argv: testArgv,
            cwd: fixture.ws1,
            extraEnv: { FAKE_OUTPUT_COUNT: '20', FAKE_OUTPUT_INTERVAL: '0.08' },
            sleep: '2.5',
            timeoutMs: 15_000,
          }),
        );
        const started = yield* pollReport(fixture, (report) => runningLeader(report) !== undefined);
        const leader = runningLeader(started);
        const leaderTicket = leader?.ticket ?? '';
        expect(leaderTicket).toMatch(/^cc-\d+$/u);
        expect(leader?.estimateMs ?? 0).toBeLessThan(5_000);

        const followerFiber = yield* Effect.forkChild(
          execRequest(fixture, {
            argv: ['cargo', 'check', '-p', 'ws1'],
            cwd: fixture.ws1,
            timeoutMs: 15_000,
          }),
        );

        const overrun = yield* pollReport(
          fixture,
          (report) => {
            const head = report.active.find((record) => record.ticket === leaderTicket);
            const follower = report.active.find(
              (record) => record.status === 'queued' && record.ticket !== leaderTicket,
            );
            return (
              head?.estimateState === 'overrun' &&
              head.stall === undefined &&
              (follower?.queue?.waitEtaMs ?? 0) > 0
            );
          },
          80,
        );
        const head = overrun.active.find((record) => record.ticket === leaderTicket);
        const follower = overrun.active.find(
          (record) => record.status === 'queued' && record.ticket !== leaderTicket,
        );
        expect(head?.estimateState).toBe('overrun');
        expect(typeof head?.p90Ms).toBe('number');
        // Past its p90 as well, the head still owes at least one estimate's
        // worth — the follower never reads "any moment now".
        expect(follower?.queue?.waitEtaMs).toBeGreaterThanOrEqual(head?.estimateMs ?? Infinity);
        expect(follower?.queue?.headEstimateState).toBe('overrun');
        expect(head?.compileEstimateMs).toBeGreaterThan(0);
        // Overlap is off, so the daemon never sees the compile/execute split
        // of a test run and claims no phase.
        expect(head?.phase).toBeUndefined();
        expect(follower?.queue?.headPhase).toBeUndefined();

        const leaderExit = findExit(yield* Fiber.join(leaderFiber));
        expect(leaderExit.status).toBe('done');
        const followerExit = findExit(yield* Fiber.join(followerFiber));
        expect(followerExit.status).toBe('done');
      }),
    20_000,
  );
});
