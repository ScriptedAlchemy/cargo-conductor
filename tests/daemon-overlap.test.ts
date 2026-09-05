import { describe, expect, it } from 'effect-rstest';
import * as Effect from 'effect/Effect';
import * as Fiber from 'effect/Fiber';

import { requestOverSocket } from '../src/daemon/control.js';
import type {
  AckMessage,
  KillResultMessage,
  StatusReport,
  TicketSummary,
} from '../src/daemon/protocol.js';

import { decodeOutput, execRequest, findExit, pollReport, scopedDaemon, shortId } from './harness.js';

const findAck = (messages: readonly { type: string }[]): AckMessage => {
  const ack = messages.find((message): message is AckMessage => message.type === 'ack');
  if (ack === undefined) {
    throw new Error('no ack message');
  }
  return ack;
};

const runningLeader = (report: StatusReport): TicketSummary | undefined =>
  report.active.find((record) => record.status === 'running' && record.attachedTo === null);

const recordFor = (report: StatusReport, ticket: string): TicketSummary | undefined =>
  [...report.active, ...report.recent].find((record) => record.ticket === ticket);

const laneExecuting = (report: StatusReport, ticket: string): boolean =>
  report.lanes.some((lane) => lane.executingTickets?.includes(ticket) === true);

const settled = (ticket: string) => (report: StatusReport) =>
  report.recent.some((record) => record.ticket === ticket && record.status !== 'running');

const testLeader = ['cargo', 'test', '-p', 'alpha'];
const nextCompile = ['cargo', 'check', '-p', 'beta'];

describe('execution-phase overlap', () => {
  it.live('hands the lane to the next compile once a test leader reports its build finished', () =>
    Effect.gen(function* () {
      const fixture = yield* scopedDaemon(5);
      const leaderFiber = yield* Effect.forkChild(
        execRequest(fixture, {
          cwd: fixture.ws1,
          argv: testLeader,
          finishedAfter: '0.2',
          sleep: '1.5',
          timeoutMs: 12_000,
        }),
      );
      const started = yield* pollReport(fixture, (report) => runningLeader(report) !== undefined);
      const leaderTicket = runningLeader(started)?.ticket ?? '';
      const followerFiber = yield* Effect.forkChild(
        execRequest(fixture, { cwd: fixture.ws1, argv: nextCompile, sleep: '0.6', timeoutMs: 12_000 }),
      );
      // While the follower compiles, the lane lists the leader as executing
      // and the follower as its running head.
      const overlapped = yield* pollReport(
        fixture,
        (report) =>
          laneExecuting(report, leaderTicket) &&
          report.lanes.some(
            (lane) => lane.runningTicket !== null && lane.runningTicket !== leaderTicket,
          ),
      );
      const lane = overlapped.lanes.find((candidate) =>
        candidate.executingTickets?.includes(leaderTicket),
      );
      expect(lane?.queued).toBe(0);
      expect(overlapped.active.filter((record) => record.status === 'running')).toHaveLength(2);

      const followerExit = findExit(yield* Fiber.join(followerFiber));
      expect(followerExit.status).toBe('done');
      const leaderExit = findExit(yield* Fiber.join(leaderFiber));
      expect(leaderExit.status).toBe('done');
      expect(leaderExit.ticket).toBe(leaderTicket);

      const report = yield* pollReport(fixture, settled(leaderTicket));
      const leader = recordFor(report, leaderTicket);
      const follower = recordFor(report, followerExit.ticket);
      expect(leader?.buildFinishedAtMs).toBeGreaterThanOrEqual(leader?.startedAtMs ?? Number.NaN);
      expect(leader?.buildFinishedAtMs).toBeLessThanOrEqual(leader?.finishedAtMs ?? Number.NaN);
      expect(follower?.startedAtMs).toBeGreaterThanOrEqual(leader?.buildFinishedAtMs ?? Number.NaN);
      expect(follower?.finishedAtMs).toBeLessThan(leader?.finishedAtMs ?? Number.NaN);
      // Nothing lingers in the lane once both settled.
      expect(
        report.lanes.every(
          (candidate) =>
            candidate.runningTicket === null && (candidate.executingTickets?.length ?? 0) === 0,
        ),
      ).toBe(true);
    }));

  it.live('keeps a compile-only leader in the lane even when its output carries a finished line', () =>
    Effect.gen(function* () {
      const fixture = yield* scopedDaemon(5);
      const leaderFiber = yield* Effect.forkChild(
        execRequest(fixture, {
          cwd: fixture.ws1,
          argv: ['cargo', 'build', '-p', 'alpha'],
          finishedAfter: '0.1',
          sleep: '0.8',
          timeoutMs: 12_000,
        }),
      );
      yield* pollReport(fixture, (report) => runningLeader(report) !== undefined);
      const followerExit = findExit(
        yield* execRequest(fixture, { cwd: fixture.ws1, argv: nextCompile, timeoutMs: 12_000 }),
      );
      const leaderExit = findExit(yield* Fiber.join(leaderFiber));
      const report = yield* pollReport(fixture, settled(followerExit.ticket));
      const leader = recordFor(report, leaderExit.ticket);
      const follower = recordFor(report, followerExit.ticket);
      expect(leader?.buildFinishedAtMs ?? null).toBeNull();
      expect(follower?.startedAtMs).toBeGreaterThanOrEqual(leader?.finishedAtMs ?? Number.NaN);
    }));

  it.live('holds the lane when a test leader never prints the finished line', () =>
    Effect.gen(function* () {
      const fixture = yield* scopedDaemon(5);
      const leaderFiber = yield* Effect.forkChild(
        execRequest(fixture, { cwd: fixture.ws1, argv: testLeader, sleep: '0.8', timeoutMs: 12_000 }),
      );
      yield* pollReport(fixture, (report) => runningLeader(report) !== undefined);
      const followerExit = findExit(
        yield* execRequest(fixture, { cwd: fixture.ws1, argv: nextCompile, timeoutMs: 12_000 }),
      );
      const leaderExit = findExit(yield* Fiber.join(leaderFiber));
      const report = yield* pollReport(fixture, settled(followerExit.ticket));
      const leader = recordFor(report, leaderExit.ticket);
      const follower = recordFor(report, followerExit.ticket);
      expect(leader?.buildFinishedAtMs ?? null).toBeNull();
      expect(follower?.startedAtMs).toBeGreaterThanOrEqual(leader?.finishedAtMs ?? Number.NaN);
    }));

  it.live('CARGO_HAULER_OVERLAP_EXECUTION=0 restores one process per lane', () =>
    Effect.gen(function* () {
      const fixture = yield* scopedDaemon(5, { CARGO_HAULER_OVERLAP_EXECUTION: '0' });
      const leaderFiber = yield* Effect.forkChild(
        execRequest(fixture, {
          cwd: fixture.ws1,
          argv: testLeader,
          finishedAfter: '0.1',
          sleep: '0.8',
          timeoutMs: 12_000,
        }),
      );
      yield* pollReport(fixture, (report) => runningLeader(report) !== undefined);
      const followerExit = findExit(
        yield* execRequest(fixture, { cwd: fixture.ws1, argv: nextCompile, timeoutMs: 12_000 }),
      );
      const leaderExit = findExit(yield* Fiber.join(leaderFiber));
      const report = yield* pollReport(fixture, settled(followerExit.ticket));
      const leader = recordFor(report, leaderExit.ticket);
      const follower = recordFor(report, followerExit.ticket);
      expect(leader?.buildFinishedAtMs ?? null).toBeNull();
      expect(follower?.startedAtMs).toBeGreaterThanOrEqual(leader?.finishedAtMs ?? Number.NaN);
    }));

  it.live('an executing leader keeps its admission permit, so the next compile still needs one', () =>
    Effect.gen(function* () {
      const fixture = yield* scopedDaemon(1);
      const leaderFiber = yield* Effect.forkChild(
        execRequest(fixture, {
          cwd: fixture.ws1,
          argv: testLeader,
          finishedAfter: '0.1',
          sleep: '0.8',
          timeoutMs: 12_000,
        }),
      );
      yield* pollReport(fixture, (report) => runningLeader(report) !== undefined);
      const followerExit = findExit(
        yield* execRequest(fixture, { cwd: fixture.ws1, argv: nextCompile, timeoutMs: 12_000 }),
      );
      const leaderExit = findExit(yield* Fiber.join(leaderFiber));
      const report = yield* pollReport(fixture, settled(followerExit.ticket));
      const leader = recordFor(report, leaderExit.ticket);
      const follower = recordFor(report, followerExit.ticket);
      expect(typeof leader?.buildFinishedAtMs).toBe('number');
      expect(follower?.startedAtMs).toBeGreaterThanOrEqual(leader?.finishedAtMs ?? Number.NaN);
    }));

  it.live('an identity rider attaching during the execution phase mirrors the leader and its stamp', () =>
    Effect.gen(function* () {
      const fixture = yield* scopedDaemon(5);
      const leaderFiber = yield* Effect.forkChild(
        execRequest(fixture, {
          cwd: fixture.ws1,
          argv: testLeader,
          finishedAfter: '0.1',
          sleep: '1.5',
          timeoutMs: 12_000,
        }),
      );
      const started = yield* pollReport(fixture, (report) => runningLeader(report) !== undefined);
      const leaderTicket = runningLeader(started)?.ticket ?? '';
      yield* pollReport(fixture, (report) => laneExecuting(report, leaderTicket));
      const riderMessages = yield* execRequest(fixture, {
        cwd: fixture.ws1,
        argv: testLeader,
        finishedAfter: '0.1',
        sleep: '1.5',
        timeoutMs: 12_000,
      });
      const ack = findAck(riderMessages);
      expect(ack.attachedTo).toBe(leaderTicket);
      expect(ack.attachMode).toBe('identity');
      const riderExit = findExit(riderMessages);
      expect(riderExit.status).toBe('done');
      expect(decodeOutput(riderMessages, 'stderr')).toContain('Finished `test` profile');
      const leaderExit = findExit(yield* Fiber.join(leaderFiber));
      const report = yield* pollReport(fixture, settled(riderExit.ticket));
      const leader = recordFor(report, leaderExit.ticket);
      const rider = recordFor(report, riderExit.ticket);
      expect(typeof leader?.buildFinishedAtMs).toBe('number');
      expect(rider?.buildFinishedAtMs).toBe(leader?.buildFinishedAtMs);
      expect(rider?.attachedTo).toBe(leaderTicket);
      // Riding a leader mid-execution costs no queue wait: the counterfactual
      // starts at the leader start, so the rider's latency is signed against
      // the part of the run it actually rode.
      expect(typeof rider?.savedLatencyMs).toBe('number');
    }));

  it.live('several execution phases may overlap while compiles stay serialized', () =>
    Effect.gen(function* () {
      const fixture = yield* scopedDaemon(5);
      const first = yield* Effect.forkChild(
        execRequest(fixture, {
          cwd: fixture.ws1,
          argv: ['cargo', 'test', '-p', 'one'],
          finishedAfter: '0.1',
          sleep: '1.5',
          timeoutMs: 12_000,
        }),
      );
      const started = yield* pollReport(fixture, (report) => runningLeader(report) !== undefined);
      const firstTicket = runningLeader(started)?.ticket ?? '';
      const second = yield* Effect.forkChild(
        execRequest(fixture, {
          cwd: fixture.ws1,
          argv: ['cargo', 'test', '-p', 'two'],
          finishedAfter: '0.1',
          sleep: '1.5',
          timeoutMs: 12_000,
        }),
      );
      const both = yield* pollReport(fixture, (report) =>
        report.lanes.some((lane) => (lane.executingTickets?.length ?? 0) === 2),
      );
      expect(both.active.filter((record) => record.status === 'running')).toHaveLength(2);
      const followerExit = findExit(
        yield* execRequest(fixture, { cwd: fixture.ws1, argv: nextCompile, timeoutMs: 12_000 }),
      );
      expect(followerExit.status).toBe('done');
      const firstExit = findExit(yield* Fiber.join(first));
      const secondExit = findExit(yield* Fiber.join(second));
      expect(firstExit.status).toBe('done');
      expect(secondExit.status).toBe('done');
      const report = yield* pollReport(fixture, settled(secondExit.ticket));
      const one = recordFor(report, firstTicket);
      const two = recordFor(report, secondExit.ticket);
      const follower = recordFor(report, followerExit.ticket);
      // Each compile started only after the previous build finished.
      expect(two?.startedAtMs).toBeGreaterThanOrEqual(one?.buildFinishedAtMs ?? Number.NaN);
      expect(follower?.startedAtMs).toBeGreaterThanOrEqual(two?.buildFinishedAtMs ?? Number.NaN);
      expect(follower?.finishedAtMs).toBeLessThan(one?.finishedAtMs ?? Number.NaN);
    }));

  it.live('killing a leader during its execution phase settles it killed and leaves the lane flowing', () =>
    Effect.gen(function* () {
      const fixture = yield* scopedDaemon(5);
      const leaderFiber = yield* Effect.forkChild(
        execRequest(fixture, {
          cwd: fixture.ws1,
          argv: testLeader,
          finishedAfter: '0.1',
          sleep: '10',
          timeoutMs: 15_000,
        }),
      );
      const started = yield* pollReport(fixture, (report) => runningLeader(report) !== undefined);
      const leaderTicket = runningLeader(started)?.ticket ?? '';
      yield* pollReport(fixture, (report) => laneExecuting(report, leaderTicket));
      const followerFiber = yield* Effect.forkChild(
        execRequest(fixture, { cwd: fixture.ws1, argv: nextCompile, sleep: '0.5', timeoutMs: 12_000 }),
      );
      yield* pollReport(fixture, (report) =>
        report.lanes.some(
          (lane) => lane.runningTicket !== null && lane.runningTicket !== leaderTicket,
        ),
      );
      const killMessages = yield* requestOverSocket({
        socketPath: fixture.config.socketPath,
        message: { type: 'kill', id: shortId(), ticket: leaderTicket },
        isTerminal: (message) => message.type === 'kill-result',
      });
      const killResult = killMessages.find(
        (message): message is KillResultMessage => message.type === 'kill-result',
      );
      expect(killResult?.killed).toBe(true);
      const leaderExit = findExit(yield* Fiber.join(leaderFiber));
      expect(leaderExit.status).toBe('killed');
      const followerExit = findExit(yield* Fiber.join(followerFiber));
      expect(followerExit.status).toBe('done');
      const report = yield* pollReport(fixture, settled(followerExit.ticket));
      expect(
        report.lanes.every(
          (lane) => lane.runningTicket === null && (lane.executingTickets?.length ?? 0) === 0,
        ),
      ).toBe(true);
      expect(recordFor(report, leaderTicket)?.status).toBe('killed');
    }));

  it.live('an env-prefixed test leader hands the lane back and identity-attaches a twin', () =>
    Effect.gen(function* () {
      const fixture = yield* scopedDaemon(5);
      const argv = ['env', 'FAKE_MARK=1', 'cargo', 'test', '-p', 'alpha'];
      const leaderFiber = yield* Effect.forkChild(
        execRequest(fixture, { cwd: fixture.ws1, argv, finishedAfter: '0.1', sleep: '1.5', timeoutMs: 12_000 }),
      );
      const started = yield* pollReport(fixture, (report) => runningLeader(report) !== undefined);
      const leaderTicket = runningLeader(started)?.ticket ?? '';
      yield* pollReport(fixture, (report) => laneExecuting(report, leaderTicket));
      const riderMessages = yield* execRequest(fixture, {
        cwd: fixture.ws1,
        argv,
        finishedAfter: '0.1',
        sleep: '1.5',
        timeoutMs: 12_000,
      });
      expect(findAck(riderMessages).attachedTo).toBe(leaderTicket);
      expect(findExit(riderMessages).status).toBe('done');
      const leaderExit = findExit(yield* Fiber.join(leaderFiber));
      const report = yield* pollReport(fixture, settled(leaderExit.ticket));
      const leader = recordFor(report, leaderTicket);
      expect(typeof leader?.buildFinishedAtMs).toBe('number');
      expect(leader?.intentJson === null ? null : JSON.parse(leader?.intentJson ?? '{}').subcommand).toBe('test');
    }));

  it.live('a bash -c wrapped test hands the lane back but never shares its run', () =>
    Effect.gen(function* () {
      const fixture = yield* scopedDaemon(5);
      const argv = ['bash', '-c', 'cargo test -p alpha'];
      const leaderFiber = yield* Effect.forkChild(
        execRequest(fixture, { cwd: fixture.ws1, argv, finishedAfter: '0.1', sleep: '1.5', timeoutMs: 12_000 }),
      );
      const started = yield* pollReport(fixture, (report) => runningLeader(report) !== undefined);
      const leaderTicket = runningLeader(started)?.ticket ?? '';
      yield* pollReport(fixture, (report) => laneExecuting(report, leaderTicket));
      const twinFiber = yield* Effect.forkChild(
        execRequest(fixture, { cwd: fixture.ws1, argv, finishedAfter: '0.1', sleep: '0.3', timeoutMs: 12_000 }),
      );
      // The twin is its own leader: it compiles in the lane while the first
      // one still executes, instead of riding it.
      const overlapped = yield* pollReport(
        fixture,
        (report) =>
          laneExecuting(report, leaderTicket) &&
          report.lanes.some((lane) => lane.runningTicket !== null && lane.runningTicket !== leaderTicket),
      );
      expect(overlapped.active.filter((record) => record.status === 'running')).toHaveLength(2);
      const twinMessages = yield* Fiber.join(twinFiber);
      expect(findAck(twinMessages).attachedTo).toBeUndefined();
      expect(findExit(twinMessages).status).toBe('done');
      const leaderExit = findExit(yield* Fiber.join(leaderFiber));
      const report = yield* pollReport(fixture, settled(leaderExit.ticket));
      expect(typeof recordFor(report, leaderTicket)?.buildFinishedAtMs).toBe('number');
    }));
});
