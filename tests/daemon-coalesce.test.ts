import { describe, expect, it } from '@rstest/core';
import * as Effect from 'effect/Effect';
import * as Fiber from 'effect/Fiber';

import { createLedgerApi, openLedgerDatabase } from '../src/daemon/ledger.js';
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
  withDaemon,
} from './harness.js';

const findAck = (messages: readonly { type: string }[]): AckMessage => {
  const ack = messages.find((message): message is AckMessage => message.type === 'ack');
  if (ack === undefined) {
    throw new Error('no ack message');
  }
  return ack;
};

describe('identity coalescing', () => {
  it('attaches an identical concurrent request, replays output, and mirrors success', () =>
    withDaemon(5, (fixture) =>
      Effect.gen(function* () {
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

        // The follower is queued against the leader, then inherits the
        // leader's real running phase instead of starting at attach time.
        const db = openLedgerDatabase(fixture.config.databasePath);
        const transitions = yield* createLedgerApi(db).transitionsFor(
          Number(followerExit.ticket.slice('cc-'.length)),
        );
        db.close();
        expect(transitions.map((transition) => transition.toStatus)).toEqual([
          'requested',
          'queued',
          'running',
          'done',
        ]);
      }),
    ));

  it('mirrors an identical leader failure to the follower', () =>
    withDaemon(5, (fixture) =>
      Effect.gen(function* () {
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
      }),
    ));
});

describe('coverage subsumption', () => {
  it('lets a narrow check ride a wider build and releases it on success', () =>
    withDaemon(5, (fixture) =>
      Effect.gen(function* () {
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
      }),
    ));

  it('requeues a covered check when the stronger build fails (failed-stronger rule)', () =>
    withDaemon(5, (fixture) =>
      Effect.gen(function* () {
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
        const db = openLedgerDatabase(fixture.config.databasePath);
        const transitions = yield* createLedgerApi(db).transitionsFor(
          Number(followerExit.ticket.slice('cc-'.length)),
        );
        db.close();
        expect(transitions.map((transition) => transition.toStatus)).toEqual([
          'requested',
          'queued',
          'running',
          'queued',
          'running',
          'done',
        ]);
      }),
    ));

  it('does not attach across lanes or mismatched surfaces', () =>
    withDaemon(5, (fixture) =>
      Effect.gen(function* () {
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
      }),
    ));
});
