import { describe, expect, it } from 'effect-rstest';
import * as Effect from 'effect/Effect';
import * as Fiber from 'effect/Fiber';

import type {
  AckMessage,
  RequeuedMessage,
  StartedMessage,
} from '../src/daemon/protocol.js';

import {
  decodeOutput,
  execRequest,
  findExit,
  pollReport,
  scopedDaemon,
  scopedLedger,
} from './harness.js';

const findAck = (messages: readonly { type: string }[]): AckMessage => {
  const ack = messages.find((message): message is AckMessage => message.type === 'ack');
  if (ack === undefined) {
    throw new Error('no ack message');
  }
  return ack;
};

describe('identity coalescing', () => {
  it.live('attaches an identical concurrent request, replays output, and mirrors success', () =>
    Effect.gen(function* () {
      const fixture = yield* scopedDaemon(5);
      // Leader prints its output immediately, then sleeps: the follower
      // attaches mid-run and must receive the earlier output via replay.
      const leaderFiber = yield* Effect.forkChild(
        execRequest(fixture, { cwd: fixture.ws1, sleep: '1', timeoutMs: 12_000 }),
      );
      yield* pollReport(fixture, (report) =>
        report.active.some((record) => record.status === 'running'),
      );

      const followerMessages = yield* execRequest(fixture, {
        cwd: fixture.ws1,
        sleep: '1',
        timeoutMs: 12_000,
      });
      const followerAck = findAck(followerMessages);
      expect(followerAck.attachedTo).toMatch(/^cc-\d+$/u);
      expect(followerAck.attachMode).toBe('identity');
      expect(followerAck.etaMs).toBeGreaterThan(0);

      // Replayed leader output reaches the follower even though it was
      // emitted before the follower connected.
      expect(decodeOutput(followerMessages, 'stdout')).toContain('fake-out:check');
      expect(decodeOutput(followerMessages, 'stderr')).toContain('fake-err:check');

      const followerExit = findExit(followerMessages);
      expect(followerExit.status).toBe('done');
      expect(followerExit.exitCode).toBe(0);

      const leaderMessages = yield* Fiber.join(leaderFiber);
      const leaderExit = findExit(leaderMessages);
      expect(leaderExit.status).toBe('done');
      expect(followerAck.attachedTo).toBe(leaderExit.ticket);

      const report = yield* pollReport(fixture, (candidate) =>
        candidate.recent.some(
          (record) => record.ticket === followerExit.ticket && record.status === 'done',
        ),
      );
      const followerRecord = report.recent.find(
        (record) => record.ticket === followerExit.ticket,
      );
      const leaderRecord = report.recent.find(
        (record) => record.ticket === leaderExit.ticket,
      );
      expect(followerRecord?.attachedTo).toBe(leaderExit.ticket);
      expect(followerRecord?.attachMode).toBe('identity');
      expect(followerRecord?.startedAtMs).toBe(leaderRecord?.startedAtMs);
      expect(followerRecord?.runMs).toBe(leaderRecord?.runMs);
      expect(followerRecord?.savedComputeSource).toBe('exact');
      expect(followerRecord?.savedComputeMs).toBe(leaderRecord?.runMs);
      if (
        typeof followerRecord?.estimateMs === 'number' &&
        typeof followerRecord?.finishedAtMs === 'number'
      ) {
        // The rider could not have started before its leader did, so the
        // solo counterfactual begins at the later of the two.
        const riddenFromMs = Math.max(
          followerRecord.createdAtMs,
          leaderRecord?.startedAtMs ?? followerRecord.createdAtMs,
        );
        expect(followerRecord.savedLatencyMs).toBe(
          followerRecord.estimateMs - (followerRecord.finishedAtMs - riddenFromMs),
        );
      }

      // The follower is queued against the leader, then inherits the
      // leader's real running phase instead of starting at attach time.
      const ledger = yield* scopedLedger(fixture.config);
      const transitions = yield* ledger.transitionsFor(
        Number(followerExit.ticket.slice('cc-'.length)),
      );
      expect(transitions.map((transition) => transition.toStatus)).toEqual([
        'requested',
        'queued',
        'running',
        'done',
      ]);
    }));

  it.live('mirrors an identical leader failure to the follower', () =>
    Effect.gen(function* () {
      const fixture = yield* scopedDaemon(5);
      const leaderFiber = yield* Effect.forkChild(
        execRequest(fixture, {
          cwd: fixture.ws1,
          sleep: '0.8',
          exit: '7',
          timeoutMs: 12_000,
        }),
      );
      yield* pollReport(fixture, (report) =>
        report.active.some((record) => record.status === 'running'),
      );

      const followerMessages = yield* execRequest(fixture, {
        cwd: fixture.ws1,
        sleep: '0.8',
        exit: '7',
        timeoutMs: 12_000,
      });
      expect(findAck(followerMessages).attachMode).toBe('identity');
      const followerExit = findExit(followerMessages);
      expect(followerExit.status).toBe('failed');
      expect(followerExit.exitCode).toBe(7);

      const leaderExit = findExit(yield* Fiber.join(leaderFiber));
      expect(leaderExit.status).toBe('failed');
      expect(leaderExit.exitCode).toBe(7);
    }));
});

describe('coverage subsumption', () => {
  it.live('lets a narrow check ride a wider build and releases it on success', () =>
    Effect.gen(function* () {
      const fixture = yield* scopedDaemon(5);
      const leaderFiber = yield* Effect.forkChild(
        execRequest(fixture, {
          cwd: fixture.ws1,
          argv: ['cargo', 'build', '-p', 'aa', '-p', 'bb'],
          sleep: '1',
          timeoutMs: 12_000,
        }),
      );
      yield* pollReport(fixture, (report) =>
        report.active.some((record) => record.status === 'running'),
      );

      const followerMessages = yield* execRequest(fixture, {
        cwd: fixture.ws1,
        argv: ['cargo', 'check', '-p', 'aa'],
        timeoutMs: 12_000,
      });
      const ack = findAck(followerMessages);
      expect(ack.attachMode).toBe('coverage');

      const followerExit = findExit(followerMessages);
      expect(followerExit.status).toBe('done');
      expect(followerExit.exitCode).toBe(0);

      const leaderExit = findExit(yield* Fiber.join(leaderFiber));
      expect(leaderExit.status).toBe('done');

      const report = yield* pollReport(fixture, (candidate) =>
        candidate.recent.some((record) => record.ticket === followerExit.ticket),
      );
      const followerRecord = report.recent.find((record) => record.ticket === followerExit.ticket);
      const leaderRecord = report.recent.find((record) => record.ticket === ack.attachedTo);
      expect(followerRecord?.attachMode).toBe('coverage');
      if (
        typeof followerRecord?.estimateMs === 'number' &&
        typeof leaderRecord?.runMs === 'number'
      ) {
        const bounded = Math.min(followerRecord.estimateMs, leaderRecord.runMs);
        expect(followerRecord.savedComputeMs).toBe(bounded);
        expect(followerRecord.savedComputeSource).toBe(
          bounded === leaderRecord.runMs ? 'exact' : 'estimate',
        );
      }
    }));

  it.live('requeues a covered check when the stronger build fails (failed-stronger rule)', () =>
    Effect.gen(function* () {
      const fixture = yield* scopedDaemon(5);
      const leaderFiber = yield* Effect.forkChild(
        execRequest(fixture, {
          cwd: fixture.ws1,
          argv: ['cargo', 'build', '-p', 'aa'],
          sleep: '0.8',
          exit: '1',
          timeoutMs: 12_000,
        }),
      );
      yield* pollReport(fixture, (report) =>
        report.active.some((record) => record.status === 'running'),
      );

      // The follower itself succeeds when run directly (no FAKE_EXIT).
      const followerMessages = yield* execRequest(fixture, {
        cwd: fixture.ws1,
        argv: ['cargo', 'check', '-p', 'aa'],
        timeoutMs: 15_000,
      });
      expect(findAck(followerMessages).attachMode).toBe('coverage');

      const requeued = followerMessages.find(
        (message): message is RequeuedMessage => message.type === 'requeued',
      );
      expect(requeued).toBeDefined();
      expect(requeued?.reason).toContain('run failed');

      // After requeue the follower executed on its own and succeeded.
      const started = followerMessages.filter(
        (message): message is StartedMessage => message.type === 'started',
      );
      expect(started.length).toBeGreaterThanOrEqual(1);
      const followerExit = findExit(followerMessages);
      expect(followerExit.status).toBe('done');
      expect(followerExit.exitCode).toBe(0);
      expect(decodeOutput(followerMessages, 'stdout')).toContain('fake-out:check -p aa');

      const leaderExit = findExit(yield* Fiber.join(leaderFiber));
      expect(leaderExit.status).toBe('failed');

      // Ledger shows the full journey: requested -> queued -> running
      // (attached) -> queued (requeued) -> running -> done.
      const ledger = yield* scopedLedger(fixture.config);
      const transitions = yield* ledger.transitionsFor(
        Number(followerExit.ticket.slice('cc-'.length)),
      );
      expect(transitions.map((transition) => transition.toStatus)).toEqual([
        'requested',
        'queued',
        'running',
        'queued',
        'running',
        'done',
      ]);
      const report = yield* pollReport(fixture, (candidate) =>
        candidate.recent.some((record) => record.ticket === followerExit.ticket),
      );
      const followerRecord = report.recent.find((record) => record.ticket === followerExit.ticket);
      expect(followerRecord?.savedComputeMs).toBeNull();
      expect(followerRecord?.savedComputeSource).toBeNull();
      expect(followerRecord?.savedLatencyMs).toBeNull();
    }));

  it.live('records negative saved latency when an attached rider waits longer than its estimate', () =>
    Effect.gen(function* () {
      const fixture = yield* scopedDaemon(5);
      // Warm a fast sample so the follower estimate reflects a short solo run.
      yield* execRequest(fixture, {
        cwd: fixture.ws1,
        sleep: '0.05',
        timeoutMs: 12_000,
      });
      const leaderFiber = yield* Effect.forkChild(
        execRequest(fixture, {
          cwd: fixture.ws1,
          sleep: '1.2',
          timeoutMs: 12_000,
        }),
      );
      yield* pollReport(fixture, (report) =>
        report.active.some((record) => record.status === 'running'),
      );
      const followerMessages = yield* execRequest(fixture, {
        cwd: fixture.ws1,
        sleep: '1.2',
        timeoutMs: 12_000,
      });
      const followerExit = findExit(followerMessages);
      expect(followerExit.status).toBe('done');
      yield* Fiber.join(leaderFiber);
      const report = yield* pollReport(fixture, (candidate) =>
        candidate.recent.some((record) => record.ticket === followerExit.ticket),
      );
      const followerRecord = report.recent.find((record) => record.ticket === followerExit.ticket);
      expect(followerRecord?.savedComputeSource).toBe('exact');
      expect(typeof followerRecord?.savedLatencyMs).toBe('number');
      expect((followerRecord?.savedLatencyMs ?? 0) < 0).toBe(true);
    }));

  it.live('does not attach across lanes or mismatched surfaces', () =>
    Effect.gen(function* () {
      const fixture = yield* scopedDaemon(5);
      const leaderFiber = yield* Effect.forkChild(
        execRequest(fixture, {
          cwd: fixture.ws1,
          argv: ['cargo', 'build', '-p', 'aa'],
          sleep: '0.7',
          timeoutMs: 12_000,
        }),
      );
      yield* pollReport(fixture, (report) =>
        report.active.some((record) => record.status === 'running'),
      );

      // Different workspace: no attach.
      const otherLane = yield* execRequest(fixture, {
        cwd: fixture.ws2,
        argv: ['cargo', 'check', '-p', 'aa'],
        timeoutMs: 12_000,
      });
      expect(findAck(otherLane).attachedTo).toBeUndefined();

      // Different profile: no attach (queues behind the leader instead).
      const otherProfile = yield* execRequest(fixture, {
        cwd: fixture.ws1,
        argv: ['cargo', 'check', '-p', 'aa', '--release'],
        timeoutMs: 12_000,
      });
      expect(findAck(otherProfile).attachedTo).toBeUndefined();

      findExit(yield* Fiber.join(leaderFiber));
    }));
});
