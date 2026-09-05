import { join } from 'node:path';

import { describe, expect, it } from 'effect-rstest';
import * as Deferred from 'effect/Deferred';
import * as Effect from 'effect/Effect';
import * as Fiber from 'effect/Fiber';
import * as Layer from 'effect/Layer';
import * as Logger from 'effect/Logger';
import * as References from 'effect/References';

import { Broker } from '../src/daemon/broker.js';
import type { BrokerApi, SubmitResult } from '../src/daemon/broker.js';
import type { ExitInfo, SubmitInput } from '../src/daemon/job-state.js';
import type {
  AckMessage,
  RequeuedMessage,
  RequestRecord,
  StatusReport,
} from '../src/daemon/protocol.js';

import { brokerFixture } from './broker-fixture.js';
import {
  decodeOutput,
  execRequest,
  fetchReport,
  findExit,
  pollReport,
  scopedDaemon,
  scopedLedger,
} from './harness.js';
import type { Fixture } from './harness.js';

const findAck = (messages: readonly { type: string }[]): AckMessage => {
  const ack = messages.find((message): message is AckMessage => message.type === 'ack');
  if (ack === undefined) {
    throw new Error('no ack message');
  }
  return ack;
};

const runningLeader = (report: StatusReport): RequestRecord | undefined =>
  report.active.find((record) => record.status === 'running' && record.attachedTo === null);

const recordFor = (report: StatusReport, ticket: string): RequestRecord | undefined =>
  [...report.active, ...report.recent].find((record) => record.ticket === ticket);

const laneExecuting = (report: StatusReport, ticket: string): boolean =>
  report.lanes.some((lane) => lane.executingTickets?.includes(ticket) === true);

const settled = (ticket: string) => (report: StatusReport) =>
  report.recent.some((record) => record.ticket === ticket && record.status !== 'running');

/**
 * Metrics live in the process-wide registry, so every daemon a test file
 * starts adds to the same counters: assertions compare against a snapshot
 * taken just before the request under test.
 */
const rejections = (report: StatusReport, gate: string): number =>
  report.metrics?.attach_rejections?.[gate] ?? 0;

const coverageAttaches = (report: StatusReport): number =>
  report.metrics?.attach_mode?.coverage ?? 0;

/** The observed pair (#88): a filtered `--lib` test run and the `--no-run` compile of the same lib. */
const filteredTest = [
  'cargo',
  'test',
  '-p',
  'alpha',
  '--lib',
  'daemon::tests::route',
  'mcp::server::tests::wire',
  '--',
  '--test-threads=4',
];
const noRunCompile = ['cargo', 'test', '-p', 'alpha', '--lib', '--no-run'];

describe('test --no-run riding a running test (#88)', () => {
  it.live('releases the rider at the leader\'s build-finished line while the leader still runs its tests', () =>
    Effect.gen(function* () {
      const fixture = yield* scopedDaemon(5);
      const leaderFiber = yield* Effect.forkChild(
        execRequest(fixture, {
          cwd: fixture.ws1,
          argv: filteredTest,
          finishedAfter: '1.5',
          sleep: '2',
          timeoutMs: 15_000,
        }),
      );
      const started = yield* pollReport(fixture, (report) => runningLeader(report) !== undefined);
      const leaderTicket = runningLeader(started)?.ticket ?? '';
      const coverageBefore = coverageAttaches(started);

      const riderMessages = yield* execRequest(fixture, {
        cwd: fixture.ws1,
        argv: noRunCompile,
        timeoutMs: 15_000,
      });
      const ack = findAck(riderMessages);
      expect(ack.attachedTo).toBe(leaderTicket);
      expect(ack.attachMode).toBe('coverage');
      const riderExit = findExit(riderMessages);
      expect(riderExit.status).toBe('done');
      expect(riderExit.exitCode).toBe(0);
      const riderStderr = decodeOutput(riderMessages, 'stderr');
      expect(riderStderr).toContain('Finished `test` profile');
      expect(riderStderr).toContain(`released early: build finished under ${leaderTicket}`);
      // The rider is done while the leader's tests are still running.
      const during = yield* fetchReport(fixture);
      expect(laneExecuting(during, leaderTicket)).toBe(true);
      expect(recordFor(during, leaderTicket)?.status).toBe('running');

      const leaderExit = findExit(yield* Fiber.join(leaderFiber));
      expect(leaderExit.status).toBe('done');
      const report = yield* pollReport(fixture, settled(leaderTicket));
      const leader = recordFor(report, leaderTicket);
      const rider = recordFor(report, riderExit.ticket);
      expect(typeof leader?.buildFinishedAtMs).toBe('number');
      expect(rider?.buildFinishedAtMs).toBe(leader?.buildFinishedAtMs);
      expect(rider?.finishedAtMs).toBeLessThan(leader?.finishedAtMs ?? Number.NaN);
      expect(rider?.attachedTo).toBe(leaderTicket);
      expect(rider?.attachMode).toBe('coverage');
      expect(rider?.status).toBe('done');
      expect(typeof rider?.savedComputeMs).toBe('number');
      expect(typeof rider?.savedLatencyMs).toBe('number');
      expect(coverageAttaches(report)).toBe(coverageBefore + 1);

      // Attached, then released as done at the build: one running phase, no requeue.
      const ledger = yield* scopedLedger(fixture.config);
      const transitions = yield* ledger.transitionsFor(
        Number(riderExit.ticket.slice('cc-'.length)),
      );
      expect(transitions.map((transition) => transition.toStatus)).toEqual([
        'requested',
        'queued',
        'running',
        'done',
      ]);
    }));

  it.live('requeues the rider when the leader\'s build fails before any finished line', () =>
    Effect.gen(function* () {
      const fixture = yield* scopedDaemon(5);
      const leaderFiber = yield* Effect.forkChild(
        execRequest(fixture, {
          cwd: fixture.ws1,
          argv: filteredTest,
          sleep: '0.8',
          exit: '101',
          timeoutMs: 15_000,
        }),
      );
      yield* pollReport(fixture, (report) => runningLeader(report) !== undefined);

      // The rider itself succeeds when run directly (no FAKE_EXIT).
      const riderMessages = yield* execRequest(fixture, {
        cwd: fixture.ws1,
        argv: noRunCompile,
        timeoutMs: 15_000,
      });
      expect(findAck(riderMessages).attachMode).toBe('coverage');
      const requeued = riderMessages.find(
        (message): message is RequeuedMessage => message.type === 'requeued',
      );
      expect(requeued?.reason).toContain('covering run failed');
      const riderExit = findExit(riderMessages);
      expect(riderExit.status).toBe('done');
      expect(riderExit.exitCode).toBe(0);
      expect(decodeOutput(riderMessages, 'stdout')).toContain(
        'fake-out:test -p alpha --lib --no-run',
      );

      const leaderExit = findExit(yield* Fiber.join(leaderFiber));
      expect(leaderExit.status).toBe('failed');
      expect(leaderExit.exitCode).toBe(101);

      const ledger = yield* scopedLedger(fixture.config);
      const transitions = yield* ledger.transitionsFor(
        Number(riderExit.ticket.slice('cc-'.length)),
      );
      expect(transitions.map((transition) => transition.toStatus)).toEqual([
        'requested',
        'queued',
        'running',
        'queued',
        'running',
        'done',
      ]);
      const report = yield* pollReport(fixture, settled(riderExit.ticket));
      const rider = recordFor(report, riderExit.ticket);
      expect(rider?.buildFinishedAtMs ?? null).toBeNull();
      expect(rider?.savedComputeMs).toBeNull();
    }));

  it.live('a rider arriving after the build finished runs its own cargo and counts as a leader-build-finished miss', () =>
    Effect.gen(function* () {
      const fixture = yield* scopedDaemon(5);
      const leaderFiber = yield* Effect.forkChild(
        execRequest(fixture, {
          cwd: fixture.ws1,
          argv: filteredTest,
          finishedAfter: '0.1',
          sleep: '2',
          timeoutMs: 15_000,
        }),
      );
      const started = yield* pollReport(fixture, (report) => runningLeader(report) !== undefined);
      const leaderTicket = runningLeader(started)?.ticket ?? '';
      const executing = yield* pollReport(fixture, (report) => laneExecuting(report, leaderTicket));
      const missesBefore = rejections(executing, 'leader-build-finished');

      const riderMessages = yield* execRequest(fixture, {
        cwd: fixture.ws1,
        argv: noRunCompile,
        timeoutMs: 15_000,
      });
      expect(findAck(riderMessages).attachedTo).toBeUndefined();
      const riderExit = findExit(riderMessages);
      expect(riderExit.status).toBe('done');
      expect(decodeOutput(riderMessages, 'stdout')).toContain(
        'fake-out:test -p alpha --lib --no-run',
      );
      // The lane was handed on at the leader's build, so the rider's own
      // compile ran beside the leader's tests rather than behind them.
      const during = yield* fetchReport(fixture);
      expect(recordFor(during, leaderTicket)?.status).toBe('running');
      expect(rejections(during, 'leader-build-finished')).toBe(missesBefore + 1);
      findExit(yield* Fiber.join(leaderFiber));
    }));

  it.live('does not attach across target selections and counts the miss under targets', () =>
    Effect.gen(function* () {
      const fixture = yield* scopedDaemon(5);
      const leaderFiber = yield* Effect.forkChild(
        execRequest(fixture, {
          cwd: fixture.ws1,
          argv: ['cargo', 'test', '-p', 'alpha', '--test', 'mcp_suite'],
          finishedAfter: '0.6',
          sleep: '0.6',
          timeoutMs: 15_000,
        }),
      );
      const started = yield* pollReport(fixture, (report) => runningLeader(report) !== undefined);
      const riderMessages = yield* execRequest(fixture, {
        cwd: fixture.ws1,
        argv: noRunCompile,
        timeoutMs: 15_000,
      });
      expect(findAck(riderMessages).attachedTo).toBeUndefined();
      expect(findExit(riderMessages).status).toBe('done');
      findExit(yield* Fiber.join(leaderFiber));
      const report = yield* fetchReport(fixture);
      expect(rejections(report, 'targets')).toBe(rejections(started, 'targets') + 1);
      expect(coverageAttaches(report)).toBe(coverageAttaches(started));
    }));
});

describe('coverage gates over real argv shapes (#89)', () => {
  it.live('lets check --tests ride build --tests', () =>
    Effect.gen(function* () {
      const fixture = yield* scopedDaemon(5);
      const leaderFiber = yield* Effect.forkChild(
        execRequest(fixture, {
          cwd: fixture.ws1,
          argv: ['cargo', 'build', '-p', 'aa', '-p', 'bb', '--tests'],
          sleep: '1',
          timeoutMs: 15_000,
        }),
      );
      yield* pollReport(fixture, (report) => runningLeader(report) !== undefined);
      const riderMessages = yield* execRequest(fixture, {
        cwd: fixture.ws1,
        argv: ['cargo', 'check', '-p', 'aa', '--tests'],
        timeoutMs: 15_000,
      });
      const ack = findAck(riderMessages);
      expect(ack.attachMode).toBe('coverage');
      expect(findExit(riderMessages).status).toBe('done');
      const leaderExit = findExit(yield* Fiber.join(leaderFiber));
      expect(ack.attachedTo).toBe(leaderExit.ticket);
    }));

  it.live('shares identical unmodeled flags but refuses differing ones, counting the miss', () =>
    Effect.gen(function* () {
      const fixture = yield* scopedDaemon(5);
      const leaderFiber = yield* Effect.forkChild(
        execRequest(fixture, {
          cwd: fixture.ws1,
          argv: ['cargo', 'build', '-p', 'aa', '--locked'],
          sleep: '1.2',
          timeoutMs: 15_000,
        }),
      );
      const started = yield* pollReport(fixture, (report) => runningLeader(report) !== undefined);
      const sameFlags = yield* Effect.forkChild(
        execRequest(fixture, {
          cwd: fixture.ws1,
          argv: ['cargo', 'check', '-p', 'aa', '--locked'],
          timeoutMs: 15_000,
        }),
      );
      const otherFlags = yield* Effect.forkChild(
        execRequest(fixture, {
          cwd: fixture.ws1,
          argv: ['cargo', 'check', '-p', 'aa'],
          timeoutMs: 15_000,
        }),
      );
      const sameMessages = yield* Fiber.join(sameFlags);
      const otherMessages = yield* Fiber.join(otherFlags);
      const leaderExit = findExit(yield* Fiber.join(leaderFiber));
      expect(findAck(sameMessages).attachMode).toBe('coverage');
      expect(findAck(sameMessages).attachedTo).toBe(leaderExit.ticket);
      expect(findExit(sameMessages).status).toBe('done');
      expect(findAck(otherMessages).attachedTo).toBeUndefined();
      expect(findExit(otherMessages).status).toBe('done');
      expect(decodeOutput(otherMessages, 'stdout')).toContain('fake-out:check -p aa');
      const report = yield* fetchReport(fixture);
      expect(rejections(report, 'opaque-arguments')).toBe(
        rejections(started, 'opaque-arguments') + 1,
      );
      expect(coverageAttaches(report)).toBe(coverageAttaches(started) + 1);
    }));
});

const cargoEnv = (
  fixture: Fixture,
  extra: Readonly<Record<string, string>> = {},
): Record<string, string> => ({
  CARGO_HAULER_CARGO_BIN: join(fixture.binDir, 'cargo'),
  ...extra,
});

interface Tracked {
  readonly submitted: SubmitResult;
  readonly started: Deferred.Deferred<void>;
  readonly exit: Deferred.Deferred<ExitInfo>;
}

const submitTracked = (broker: BrokerApi, input: SubmitInput): Effect.Effect<Tracked, unknown> =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const exit = yield* Deferred.make<ExitInfo>();
    const submitted = yield* broker.submit(input, {
      onExit: (info) => Effect.asVoid(Deferred.succeed(exit, info)),
      onOutput: () => Effect.void,
      onStarted: () => Effect.asVoid(Deferred.succeed(started, undefined)),
    });
    return { submitted, started, exit };
  });

describe('attach rejection diagnostics (#89)', () => {
  it.live('logs each refusal at debug naming both tickets and the gate, and counts the nearest miss once', () =>
    Effect.gen(function* () {
      const { fixture, layer } = yield* brokerFixture(5);
      const lines: string[] = [];
      const collector = Logger.make((options) => {
        lines.push(JSON.stringify(options.message));
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const broker = yield* Broker;
          // Two leaders in the lane: the rider is refused by both, for
          // different gates, and the request counts once under the nearer.
          const testLeader = yield* submitTracked(broker, {
            argv: ['cargo', 'test', '-p', 'alpha', '--test', 'mcp_suite'],
            cwd: fixture.ws1,
            env: cargoEnv(fixture, { FAKE_SLEEP: '1.5' }),
          });
          yield* Deferred.await(testLeader.started);
          const clippyLeader = yield* submitTracked(broker, {
            argv: ['cargo', 'clippy', '-p', 'alpha'],
            cwd: fixture.ws1,
            env: cargoEnv(fixture),
          });
          const before = yield* broker.report();
          const rider = yield* submitTracked(broker, {
            argv: noRunCompile,
            cwd: fixture.ws1,
            env: cargoEnv(fixture),
          });
          expect(rider.submitted.attachedTo).toBeUndefined();
          // The clippy leader was itself refused by the test leader on its
          // way in; only the rider's own lines matter here.
          const rejected = lines.filter(
            (line) =>
              line.includes('attach rejected') &&
              line.includes(`"ticket":"${rider.submitted.ticket}"`),
          );
          expect(rejected).toHaveLength(2);
          const byLeader = (ticket: string): string | undefined =>
            rejected.find((line) => line.includes(`"leader":"${ticket}"`));
          const fromTest = byLeader(testLeader.submitted.ticket);
          expect(fromTest).toContain('"gate":"targets"');
          expect(fromTest).toContain('leader compiles test:mcp_suite, rider needs lib');
          const fromClippy = byLeader(clippyLeader.submitted.ticket);
          expect(fromClippy).toContain('"gate":"subcommand"');
          expect(fromClippy).toContain('cargo test cannot ride cargo clippy');

          const after = yield* broker.report();
          expect(rejections(after, 'targets')).toBe(rejections(before, 'targets') + 1);
          expect(rejections(after, 'subcommand')).toBe(rejections(before, 'subcommand'));
          yield* Deferred.await(testLeader.exit);
          yield* Deferred.await(clippyLeader.exit);
          yield* Deferred.await(rider.exit);
        }),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            layer,
            Logger.layer([collector]),
            Layer.succeed(References.MinimumLogLevel, 'Debug'),
          ),
        ),
      );
    }));
});
