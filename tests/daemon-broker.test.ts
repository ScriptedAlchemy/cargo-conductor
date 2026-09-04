import { join } from 'node:path';

import { describe, expect, it } from 'effect-rstest';
import * as Effect from 'effect/Effect';
import * as Fiber from 'effect/Fiber';

import { pingDaemon, requestOverSocket } from '../src/daemon/control.js';
import {
  quietMsSinceOutput,
  queuedWaitIsDelayed,
} from '../src/daemon/job-state.js';
import { runDaemon } from '../src/daemon/main.js';
import type {
  AckMessage,
  ErrorMessage,
  KillResultMessage,
  StartedMessage,
} from '../src/daemon/protocol.js';

import {
  decodeOutput,
  execRequest,
  fetchReport,
  findExit,
  pollReport,
  scopedDaemon,
  scopedLedger,
  shortId,
} from './harness.js';

describe('hauler daemon', () => {
  it('uses the greater of twice the estimate and ten minutes for delayed waits', () => {
    expect(queuedWaitIsDelayed(600_000, 60_000)).toBe(false);
    expect(queuedWaitIsDelayed(600_001, 60_000)).toBe(true);
    expect(queuedWaitIsDelayed(1_200_000, 600_000)).toBe(false);
    expect(queuedWaitIsDelayed(1_200_001, 600_000)).toBe(true);
  });

  it('only reports output quiet time after five minutes', () => {
    expect(quietMsSinceOutput(1_000, 301_000)).toBeUndefined();
    expect(quietMsSinceOutput(1_000, 301_001)).toBe(300_001);
  });

  it.live('runs a cargo request end to end and ledgers the full lifecycle', () =>
    Effect.gen(function* () {
      const fixture = yield* scopedDaemon(5);
      const messages = yield* execRequest(fixture, { cwd: fixture.ws1 });

      const ack = messages.find((message): message is AckMessage => message.type === 'ack');
      expect(ack).toBeDefined();
      expect(ack?.ticket).toMatch(/^cc-\d+$/u);
      expect(ack?.position).toBe(0);
      expect(ack?.laneKey).toContain('ws1');

      const started = messages.find(
        (message): message is StartedMessage => message.type === 'started',
      );
      expect(started).toBeDefined();

      expect(decodeOutput(messages, 'stdout')).toContain('fake-out:check');
      expect(decodeOutput(messages, 'stderr')).toContain('fake-err:check');

      const exit = findExit(messages);
      expect(exit.status).toBe('done');
      expect(exit.exitCode).toBe(0);
      expect(exit.waitMs).toBeGreaterThanOrEqual(0);
      expect(exit.runMs).toBeGreaterThanOrEqual(0);

      const report = yield* pollReport(
        fixture,
        (candidate) => candidate.recent.some((record) => record.ticket === exit.ticket),
      );
      const record = report.recent.find((candidate) => candidate.ticket === exit.ticket);
      expect(record?.status).toBe('done');
      expect(record?.outputTail).toBeNull();
      expect(record?.intentKey).not.toBeNull();
      expect(record?.targetDir).toBe(join(fixture.ws1, 'target'));
      // An idle lane worker parked in Queue.take must not surface as -1 queued.
      for (const lane of report.lanes) {
        expect(lane.queued).toBeGreaterThanOrEqual(0);
      }
      expect(report.metrics).toMatchObject({
        attach_mode: expect.any(Object),
        cargo_run_ms: {
          buckets: expect.any(Array),
          count: expect.any(Number),
          max: expect.anything(),
          min: expect.anything(),
          sum: expect.any(Number),
        },
        cargo_run_ms_by_kind: expect.any(Object),
        job_outcome: expect.objectContaining({ done: expect.any(Number) }),
        wait_ms_summary: {
          count: expect.any(Number),
          max: expect.anything(),
          min: expect.anything(),
          quantiles: expect.arrayContaining([
            [0.5, expect.anything()],
            [0.9, expect.anything()],
            [0.95, expect.anything()],
          ]),
          sum: expect.any(Number),
        },
      });
      expect(report.metrics?.cargo_run_ms_by_kind?.check?.count ?? 0).toBeGreaterThanOrEqual(1);
      expect(report.metrics?.wait_ms_summary?.count ?? 0).toBeGreaterThanOrEqual(1);
      expect(report.metrics?.windows?.map((window) => window.id)).toEqual([
        'hour',
        'day',
        'all',
      ]);
      expect(report.metrics?.windows?.[0]).toEqual(
        expect.objectContaining({
          bySubcommand: expect.any(Array),
          count: expect.any(Number),
          done: expect.any(Number),
          failed: expect.any(Number),
          id: 'hour',
          killed: expect.any(Number),
        }),
      );
      expect(report.metrics?.windows?.[0]?.runMeanMs).not.toBeUndefined();
      expect(report.metrics?.windows?.[0]?.runP50Ms).not.toBeUndefined();
      expect(report.metrics?.windows?.[0]?.runP95Ms).not.toBeUndefined();
      expect(report.metrics?.windows?.[0]?.waitP50Ms).not.toBeUndefined();
      expect(report.metrics?.windows?.[0]?.waitP95Ms).not.toBeUndefined();
      expect(report.savings?.byMode.map((row) => row.mode)).toEqual([
        'identity',
        'coverage',
        'batch',
      ]);
      expect(report.savings?.totals.ridersServed ?? 0).toBeGreaterThanOrEqual(0);

      const ledger = yield* scopedLedger(fixture.config);
      const durable = yield* ledger.getRequestByTicket(exit.ticket);
      const transitions = yield* ledger.transitionsFor(
        Number(exit.ticket.slice('cc-'.length)),
      );
      expect(durable?.outputTail).toContain('fake-out:check');
      expect(transitions.map((transition) => transition.toStatus)).toEqual([
        'requested',
        'queued',
        'running',
        'done',
      ]);
    }));

  it.live('reports live lane queue context, delayed waits, and quiet running jobs', () =>
    Effect.gen(function* () {
      const fixture = yield* scopedDaemon(5);
      const holderFiber = yield* Effect.forkChild(
        execRequest(fixture, {
          argv: ['cargo', 'check', '-p', 'lane-head'],
          cwd: fixture.ws1,
          sleep: '0.8',
        }),
      );
      const running = yield* pollReport(
        fixture,
        (report) =>
          report.active.some(
            (record) => record.status === 'running' && record.argv.includes('lane-head'),
          ),
      );
      const holder = running.active.find((record) => record.argv.includes('lane-head'));
      expect(holder).toBeDefined();

      const firstQueuedFiber = yield* Effect.forkChild(
        execRequest(fixture, {
          argv: ['cargo', 'check', '-p', 'first-queued'],
          cwd: fixture.ws1,
        }),
      );
      yield* pollReport(
        fixture,
        (report) =>
          report.active.some(
            (record) => record.status === 'queued' && record.argv.includes('first-queued'),
          ),
      );
      const secondQueuedFiber = yield* Effect.forkChild(
        execRequest(fixture, {
          argv: ['cargo', 'check', '-p', 'second-queued'],
          cwd: fixture.ws1,
        }),
      );
      const queued = yield* pollReport(
        fixture,
        (report) =>
          report.active.some(
            (record) =>
              record.status === 'queued' &&
              record.argv.includes('second-queued') &&
              record.queue?.position === 2,
          ),
      );
      const second = queued.active.find((record) => record.argv.includes('second-queued'));
      expect(second?.queue).toMatchObject({
        aheadTickets: expect.arrayContaining([holder?.ticket]),
        headTicket: holder?.ticket,
        position: 2,
      });
      expect(second?.queue?.headElapsedMs).toBeGreaterThanOrEqual(0);
      expect(second?.queue?.headEstimateMs).toBeGreaterThan(0);
      expect(second?.queue?.waitEtaMs).toBeGreaterThanOrEqual(0);

      // Date.now must be restored before the fibers below are joined, so this
      // stays an immediate try/finally rather than a scope finalizer.
      const realNow = Date.now;
      const advancedFromMs = realNow();
      Date.now = () => advancedFromMs + 600_001;
      try {
        const advanced = yield* fetchReport(fixture);
        const delayed = advanced.active.find((record) => record.argv.includes('second-queued'));
        const firstQueued = advanced.active.find((record) => record.argv.includes('first-queued'));
        const quiet = advanced.active.find((record) => record.argv.includes('lane-head'));
        expect(delayed?.delayed).toBe(true);
        // The overrunning head contributes zero remaining time; it must not
        // cancel out the queued job still ahead of this one.
        expect(firstQueued?.estimateMs ?? 0).toBeGreaterThan(0);
        expect(delayed?.queue?.waitEtaMs).toBe(firstQueued?.estimateMs);
        expect(quiet?.quietMs).toBeGreaterThan(300_000);
      } finally {
        Date.now = realNow;
      }

      yield* Fiber.join(holderFiber);
      yield* Fiber.join(firstQueuedFiber);
      yield* Fiber.join(secondQueuedFiber);
    }));

  it.live('serializes within a lane and runs distinct lanes in parallel', () =>
    Effect.gen(function* () {
      const fixture = yield* scopedDaemon(5);
      const holderMessages = yield* execRequest(fixture, {
        cwd: fixture.ws1,
        sleep: '0.5',
        isTerminal: (message) => message.type === 'started',
      });
      const holder = holderMessages.find(
        (message): message is StartedMessage => message.type === 'started',
      );
      expect(holder).toBeDefined();
      const holderTicket = holder?.ticket ?? '';

      // A distinct package scope so the same-lane request queues behind the
      // holder instead of coalescing onto it (identical requests attach now).
      const [sameLane, otherLane] = yield* Effect.all(
        [
          execRequest(fixture, {
            cwd: fixture.ws1,
            argv: ['cargo', 'check', '-p', 'serial-probe'],
          }),
          execRequest(fixture, { cwd: fixture.ws2 }),
        ],
        { concurrency: 'unbounded' },
      );
      const sameLaneExit = findExit(sameLane);
      const otherLaneExit = findExit(otherLane);
      expect(sameLaneExit.status).toBe('done');
      expect(otherLaneExit.status).toBe('done');

      const report = yield* pollReport(
        fixture,
        (candidate) =>
          candidate.recent.find((record) => record.ticket === holderTicket)?.status === 'done',
      );
      const recordFor = (ticket: string) =>
        report.recent.find((record) => record.ticket === ticket);
      const holderRecord = recordFor(holderTicket);
      const sameLaneRecord = recordFor(sameLaneExit.ticket);
      const otherLaneRecord = recordFor(otherLaneExit.ticket);

      expect(sameLaneRecord?.startedAtMs ?? 0).toBeGreaterThanOrEqual(
        holderRecord?.finishedAtMs ?? Number.POSITIVE_INFINITY,
      );
      expect(otherLaneRecord?.startedAtMs ?? Number.POSITIVE_INFINITY).toBeLessThan(
        holderRecord?.finishedAtMs ?? 0,
      );
      expect(report.lanes).toHaveLength(2);
    }));

  it.live('caps cross-lane concurrency at the admission gate', () =>
    Effect.gen(function* () {
      const fixture = yield* scopedDaemon(1);
      const [first, second] = yield* Effect.all(
        [
          execRequest(fixture, { cwd: fixture.ws1, sleep: '0.25' }),
          execRequest(fixture, { cwd: fixture.ws2, sleep: '0.25' }),
        ],
        { concurrency: 'unbounded' },
      );
      const tickets = [findExit(first).ticket, findExit(second).ticket];
      const report = yield* pollReport(
        fixture,
        (candidate) =>
          tickets.every(
            (ticket) =>
              candidate.recent.find((record) => record.ticket === ticket)?.status === 'done',
          ),
      );
      const records = tickets.map(
        (ticket) => report.recent.find((record) => record.ticket === ticket),
      );
      const earlier =
        (records[0]?.startedAtMs ?? 0) <= (records[1]?.startedAtMs ?? 0)
          ? records[0]
          : records[1];
      const later = earlier === records[0] ? records[1] : records[0];
      expect(later?.startedAtMs ?? 0).toBeGreaterThanOrEqual(
        earlier?.finishedAtMs ?? Number.POSITIVE_INFINITY,
      );
    }));

  it.live('kills a running request via the kill message', () =>
    Effect.gen(function* () {
      const fixture = yield* scopedDaemon(5);
      const runFiber = yield* Effect.forkChild(
        execRequest(fixture, { cwd: fixture.ws1, sleep: '10', timeoutMs: 15_000 }),
      );
      const report = yield* pollReport(fixture, (candidate) =>
        candidate.active.some((record) => record.status === 'running'),
      );
      const running = report.active.find((record) => record.status === 'running');
      expect(running).toBeDefined();
      const ticket = running?.ticket ?? '';

      const killMessages = yield* requestOverSocket({
        socketPath: fixture.config.socketPath,
        message: { type: 'kill', id: shortId(), ticket },
        isTerminal: (message) => message.type === 'kill-result',
      });
      const killResult = killMessages.find(
        (message): message is KillResultMessage => message.type === 'kill-result',
      );
      expect(killResult?.killed).toBe(true);

      const execMessages = yield* Fiber.join(runFiber);
      const exit = findExit(execMessages);
      expect(exit.status).toBe('killed');
      expect(exit.signal).toBe('SIGTERM');

      yield* pollReport(
        fixture,
        (candidate) =>
          candidate.recent.find((record) => record.ticket === ticket)?.status === 'killed',
      );
    }));

  it.live('abandons queued work when its client disconnects but finishes running work', () =>
    Effect.gen(function* () {
      const fixture = yield* scopedDaemon(5);
      const holderMessages = yield* execRequest(fixture, {
        cwd: fixture.ws1,
        sleep: '1.5',
        isTerminal: (message) => message.type === 'started',
      });
      const holderTicket =
        holderMessages.find(
          (message): message is StartedMessage => message.type === 'started',
        )?.ticket ?? '';

      // Scoped to a different package so it queues (identical requests
      // would attach to the holder and survive the disconnect by design).
      const queuedMessages = yield* execRequest(fixture, {
        cwd: fixture.ws1,
        argv: ['cargo', 'check', '-p', 'abandon-probe'],
        isTerminal: (message) => message.type === 'ack',
      });
      const queuedTicket =
        queuedMessages.find((message): message is AckMessage => message.type === 'ack')
          ?.ticket ?? '';

      const report = yield* pollReport(
        fixture,
        (candidate) =>
          candidate.recent.find((record) => record.ticket === queuedTicket)?.status ===
          'killed',
      );
      const queuedRecord = report.recent.find((record) => record.ticket === queuedTicket);
      expect(queuedRecord?.startedAtMs).toBeNull();
      expect(queuedRecord?.error).toBe('killed while queued');

      yield* pollReport(
        fixture,
        (candidate) =>
          candidate.recent.find((record) => record.ticket === holderTicket)?.status === 'done',
      );
    }));

  it.live('makes disconnect kill and startup mutually exclusive', () =>
    Effect.gen(function* () {
      const fixture = yield* scopedDaemon(1);
      const runningMessages = yield* execRequest(fixture, {
        cwd: fixture.ws1,
        argv: ['cargo', 'check', '-p', 'already-started'],
        sleep: '0.8',
        isTerminal: (message) => message.type === 'started',
      });
      const runningTicket =
        runningMessages.find(
          (message): message is StartedMessage => message.type === 'started',
        )?.ticket ?? '';

      // This lane worker removes the job from its pending list, then waits
      // for the global admission permit held by already-started.
      const queuedMessages = yield* execRequest(fixture, {
        cwd: fixture.ws2,
        argv: ['cargo', 'check', '-p', 'must-never-spawn'],
        isTerminal: (message) => message.type === 'ack',
      });
      const queuedTicket =
        queuedMessages.find((message): message is AckMessage => message.type === 'ack')
          ?.ticket ?? '';

      const report = yield* pollReport(
        fixture,
        (candidate) =>
          [runningTicket, queuedTicket].every((ticket) =>
            candidate.recent.some(
              (record) =>
                record.ticket === ticket &&
                (record.status === 'done' ||
                  record.status === 'failed' ||
                  record.status === 'killed'),
            ),
          ),
      );
      const running = report.recent.find((record) => record.ticket === runningTicket);
      const queued = report.recent.find((record) => record.ticket === queuedTicket);
      expect(running?.status).toBe('done');
      expect(running?.startedAtMs).not.toBeNull();
      expect(queued?.status).toBe('killed');
      expect(queued?.startedAtMs).toBeNull();
      expect(queued?.outputTail).toBeNull();
    }));

  it.live('rejects unparseable cargo invocations and ledgers the attempt', () =>
    Effect.gen(function* () {
      const fixture = yield* scopedDaemon(5);
      const messages = yield* execRequest(fixture, { cwd: fixture.ws1, argv: ['cargo'] });
      const error = messages.find(
        (message): message is ErrorMessage => message.type === 'error',
      );
      expect(error?.code).toBe('bad-intent');
      expect(error?.message).toContain('subcommand');

      const report = yield* pollReport(fixture, (candidate) =>
        candidate.recent.some((record) => record.status === 'failed'),
      );
      const failed = report.recent.find((record) => record.status === 'failed');
      expect(failed?.laneKey).toBe('invalid');
      expect(failed?.error).toContain('subcommand');
    }));

  it.live('enforces the daemon singleton and shuts down over the socket', () =>
    Effect.gen(function* () {
      const fixture = yield* scopedDaemon(5);
      const second = yield* runDaemon(fixture.config);
      expect(second).toBe('already-running');

      yield* requestOverSocket({
        socketPath: fixture.config.socketPath,
        message: { type: 'shutdown', id: shortId() },
        isTerminal: (message) => message.type === 'shutting-down',
        timeoutMs: 3_000,
      }).pipe(
        Effect.catchTag('ConnectionClosed', (closed) => Effect.succeed(closed.received)),
      );

      const down = yield* Effect.gen(function* () {
        for (let attempt = 0; attempt < 30; attempt += 1) {
          const alive = yield* pingDaemon(fixture.config.socketPath, 300).pipe(
            Effect.map(() => true),
            Effect.orElseSucceed(() => false),
          );
          if (!alive) {
            return true;
          }
          yield* Effect.sleep('100 millis');
        }
        return false;
      });
      expect(down).toBe(true);
    }));
});
