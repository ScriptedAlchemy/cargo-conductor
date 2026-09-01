import { join } from 'node:path';

import { describe, expect, it } from '@rstest/core';
import * as Effect from 'effect/Effect';
import * as Fiber from 'effect/Fiber';

import { pingDaemon, requestOverSocket } from '../src/daemon/control.js';
import { createLedgerApi, openLedgerDatabase } from '../src/daemon/ledger.js';
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
  findExit,
  pollReport,
  shortId,
  withDaemon,
} from './harness.js';

describe('conductor daemon', () => {
  it('runs a cargo request end to end and ledgers the full lifecycle', () =>
    withDaemon(5, (fixture) =>
      Effect.gen(function* () {
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
          job_outcome: expect.objectContaining({ done: expect.any(Number) }),
        });

        const db = openLedgerDatabase(fixture.config.databasePath);
        const ledger = createLedgerApi(db);
        const durable = yield* ledger.getRequestByTicket(exit.ticket);
        const transitions = yield* ledger.transitionsFor(
          Number(exit.ticket.slice('cc-'.length)),
        );
        db.close();
        expect(durable?.outputTail).toContain('fake-out:check');
        expect(transitions.map((transition) => transition.toStatus)).toEqual([
          'requested',
          'queued',
          'running',
          'done',
        ]);
      }),
    ));

  it('serializes within a lane and runs distinct lanes in parallel', () =>
    withDaemon(5, (fixture) =>
      Effect.gen(function* () {
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
      }),
    ));

  it('caps cross-lane concurrency at the admission gate', () =>
    withDaemon(1, (fixture) =>
      Effect.gen(function* () {
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
      }),
    ));

  it('kills a running request via the kill message', () =>
    withDaemon(5, (fixture) =>
      Effect.gen(function* () {
        const runFiber = yield* Effect.fork(
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
      }),
    ));

  it('abandons queued work when its client disconnects but finishes running work', () =>
    withDaemon(5, (fixture) =>
      Effect.gen(function* () {
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
      }),
    ));

  it('makes disconnect kill and startup mutually exclusive', () =>
    withDaemon(1, (fixture) =>
      Effect.gen(function* () {
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
      }),
    ));

  it('rejects unparseable cargo invocations and ledgers the attempt', () =>
    withDaemon(5, (fixture) =>
      Effect.gen(function* () {
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
      }),
    ));

  it('enforces the daemon singleton and shuts down over the socket', () =>
    withDaemon(5, (fixture) =>
      Effect.gen(function* () {
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
              Effect.catchAll(() => Effect.succeed(false)),
            );
            if (!alive) {
              return true;
            }
            yield* Effect.sleep('100 millis');
          }
          return false;
        });
        expect(down).toBe(true);
      }),
    ));
});
