import { join } from 'node:path';

import { describe, expect, it } from 'effect-rstest';
import * as Deferred from 'effect/Deferred';
import * as Effect from 'effect/Effect';

import { Broker } from '../src/daemon/broker.js';
import type { BrokerApi, SubmitResult } from '../src/daemon/broker.js';
import type { ExitInfo, SubmitInput } from '../src/daemon/job-state.js';
import type { RequestRecord } from '../src/daemon/protocol.js';

import { brokerFixture } from './broker-fixture.js';
import type { Fixture } from './harness.js';

/**
 * `--after`: a dependent ticket stays queued until every prerequisite has
 * settled, whatever the scheduler would otherwise prefer (#45). Runs the
 * broker in-process over the fake cargo so timing is driven by FAKE_SLEEP.
 */
interface SubmitOptions {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly after?: readonly string[];
  readonly sleep?: string;
  readonly exit?: string;
}

interface Submitted {
  readonly result: SubmitResult;
  readonly started: Deferred.Deferred<void>;
  readonly exited: Deferred.Deferred<ExitInfo>;
}

const submit = (
  broker: BrokerApi,
  fixture: Fixture,
  options: SubmitOptions,
): Effect.Effect<Submitted, unknown> =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const exited = yield* Deferred.make<ExitInfo>();
    const env: Record<string, string> = {
      CARGO_HAULER_CARGO_BIN: join(fixture.binDir, 'cargo'),
      ...(options.sleep === undefined ? {} : { FAKE_SLEEP: options.sleep }),
      ...(options.exit === undefined ? {} : { FAKE_EXIT: options.exit }),
    };
    const input: SubmitInput = {
      argv: options.argv,
      cwd: options.cwd,
      env,
      ...(options.after === undefined ? {} : { after: options.after }),
    };
    const result = yield* broker.submit(input, {
      onExit: (info) => Effect.asVoid(Deferred.succeed(exited, info)),
      onOutput: () => Effect.void,
      onStarted: () => Effect.asVoid(Deferred.succeed(started, undefined)),
    });
    return { result, started, exited };
  });

const settled = (broker: BrokerApi, ticket: string): Effect.Effect<RequestRecord> =>
  broker.awaitTicket(ticket, 15_000).pipe(
    Effect.map((awaited) => {
      if (awaited.timedOut || awaited.record === null) {
        throw new Error(`${ticket} did not settle`);
      }
      return awaited.record;
    }),
  );

describe('explicit ticket dependencies (--after)', () => {
  it.live('holds a cheaper dependent behind its queued prerequisite in the same lane', () =>
    Effect.gen(function* () {
      const { fixture, layer } = yield* brokerFixture(5);
      yield* Effect.scoped(
        Effect.gen(function* () {
          const broker = yield* Broker;
          const holder = yield* submit(broker, fixture, {
            argv: ['cargo', 'check', '-p', 'holder'],
            cwd: fixture.ws1,
            sleep: '0.4',
          });
          yield* Deferred.await(holder.started);
          // Workspace build: the most expensive cold-start estimate in the lane.
          const build = yield* submit(broker, fixture, {
            argv: ['cargo', 'build', '--workspace'],
            cwd: fixture.ws1,
            sleep: '0.3',
          });
          // A scoped check is a quarter of the build's estimate: without the
          // dependency the scheduler would admit it first.
          const dependent = yield* submit(broker, fixture, {
            after: [build.result.ticket],
            argv: ['cargo', 'check', '-p', 'dependent'],
            cwd: fixture.ws1,
          });
          expect(dependent.result.waitingFor).toEqual([build.result.ticket]);

          const blocked = yield* broker.getTicket(dependent.result.ticket);
          expect(blocked?.status).toBe('queued');
          expect(blocked?.after).toEqual([build.result.ticket]);
          expect(blocked?.waitingFor?.map((entry) => entry.ticket)).toEqual([build.result.ticket]);

          const buildRecord = yield* settled(broker, build.result.ticket);
          const dependentRecord = yield* settled(broker, dependent.result.ticket);
          expect(buildRecord.status).toBe('done');
          expect(dependentRecord.status).toBe('done');
          expect(dependentRecord.startedAtMs ?? 0).toBeGreaterThanOrEqual(
            buildRecord.finishedAtMs ?? Number.POSITIVE_INFINITY,
          );
          expect(dependentRecord.after).toEqual([build.result.ticket]);
          expect(dependentRecord.waitingFor).toBeUndefined();
          yield* Deferred.await(holder.exited);
        }),
      ).pipe(Effect.provide(layer));
    }));

  it.live('fails the dependent (and its riders) when a prerequisite fails', () =>
    Effect.gen(function* () {
      const { fixture, layer } = yield* brokerFixture(5);
      yield* Effect.scoped(
        Effect.gen(function* () {
          const broker = yield* Broker;
          const holder = yield* submit(broker, fixture, {
            argv: ['cargo', 'check', '-p', 'holder'],
            cwd: fixture.ws1,
            sleep: '0.3',
          });
          yield* Deferred.await(holder.started);
          const failing = yield* submit(broker, fixture, {
            argv: ['cargo', 'build', '-p', 'boom'],
            cwd: fixture.ws1,
            exit: '3',
          });
          const dependent = yield* submit(broker, fixture, {
            after: [failing.result.ticket],
            argv: ['cargo', 'test', '-p', 'boom'],
            cwd: fixture.ws1,
          });
          // An identical request attaches to the blocked dependent and
          // follows the normal rider path.
          const rider = yield* submit(broker, fixture, {
            argv: ['cargo', 'test', '-p', 'boom'],
            cwd: fixture.ws1,
          });
          expect(rider.result.attachedTo).toBe(dependent.result.ticket);

          const failingRecord = yield* settled(broker, failing.result.ticket);
          expect(failingRecord.status).toBe('failed');
          expect(failingRecord.exitCode).toBe(3);

          const exit = yield* Deferred.await(dependent.exited);
          expect(exit.status).toBe('failed');
          expect(exit.exitCode).toBeNull();
          expect(exit.error).toBe(`prerequisite ${failing.result.ticket} failed`);

          const dependentRecord = yield* settled(broker, dependent.result.ticket);
          expect(dependentRecord.status).toBe('failed');
          expect(dependentRecord.exitCode).toBeNull();
          expect(dependentRecord.startedAtMs).toBeNull();
          expect(dependentRecord.error).toBe(`prerequisite ${failing.result.ticket} failed`);

          const riderRecord = yield* settled(broker, rider.result.ticket);
          expect(riderRecord.status).toBe('failed');
          expect(riderRecord.attachedTo).toBe(dependent.result.ticket);
          expect(riderRecord.error).toBe(`prerequisite ${failing.result.ticket} failed`);
          yield* Deferred.await(holder.exited);
        }),
      ).pipe(Effect.provide(layer));
    }));

  it.live('waits for a prerequisite that runs in another lane', () =>
    Effect.gen(function* () {
      const { fixture, layer } = yield* brokerFixture(5);
      yield* Effect.scoped(
        Effect.gen(function* () {
          const broker = yield* Broker;
          const prerequisite = yield* submit(broker, fixture, {
            argv: ['cargo', 'check', '-p', 'slow'],
            cwd: fixture.ws2,
            sleep: '0.4',
          });
          yield* Deferred.await(prerequisite.started);
          // ws1 is idle and permits are free: only the dependency holds it.
          const dependent = yield* submit(broker, fixture, {
            after: [prerequisite.result.ticket],
            argv: ['cargo', 'check', '-p', 'dependent'],
            cwd: fixture.ws1,
          });
          expect(dependent.result.waitingFor).toEqual([prerequisite.result.ticket]);
          const prerequisiteRecord = yield* settled(broker, prerequisite.result.ticket);
          const dependentRecord = yield* settled(broker, dependent.result.ticket);
          expect(dependentRecord.status).toBe('done');
          expect(dependentRecord.startedAtMs ?? 0).toBeGreaterThanOrEqual(
            prerequisiteRecord.finishedAtMs ?? Number.POSITIVE_INFINITY,
          );
        }),
      ).pipe(Effect.provide(layer));
    }));

  it.live('rejects an unknown prerequisite as a bad intent naming the ticket', () =>
    Effect.gen(function* () {
      const { fixture, layer, ledger } = yield* brokerFixture(5);
      yield* Effect.scoped(
        Effect.gen(function* () {
          const broker = yield* Broker;
          const rejected = yield* Effect.flip(
            submit(broker, fixture, {
              after: ['cc-999999'],
              argv: ['cargo', 'check', '-p', 'orphan'],
              cwd: fixture.ws1,
            }),
          );
          expect(rejected).toMatchObject({ _tag: 'CargoIntentError' });
          expect(String((rejected as { readonly message: string }).message)).toContain('cc-999999');
          const malformed = yield* Effect.flip(
            submit(broker, fixture, {
              after: ['not-a-ticket'],
              argv: ['cargo', 'check', '-p', 'orphan'],
              cwd: fixture.ws1,
            }),
          );
          expect(String((malformed as { readonly message: string }).message)).toContain('not-a-ticket');
        }),
      ).pipe(Effect.provide(layer));
      const recent = yield* ledger.recentRequests(10);
      expect(recent.filter((record) => record.laneKey === 'invalid' && record.status === 'failed')).toHaveLength(2);
    }));

  it.live('resolves prerequisites that already settled at submit time', () =>
    Effect.gen(function* () {
      const { fixture, layer } = yield* brokerFixture(5);
      yield* Effect.scoped(
        Effect.gen(function* () {
          const broker = yield* Broker;
          const done = yield* submit(broker, fixture, {
            argv: ['cargo', 'check', '-p', 'done-first'],
            cwd: fixture.ws1,
          });
          expect((yield* settled(broker, done.result.ticket)).status).toBe('done');
          const failed = yield* submit(broker, fixture, {
            argv: ['cargo', 'check', '-p', 'failed-first'],
            cwd: fixture.ws1,
            exit: '1',
          });
          expect((yield* settled(broker, failed.result.ticket)).status).toBe('failed');

          const afterDone = yield* submit(broker, fixture, {
            after: [done.result.ticket, done.result.ticket],
            argv: ['cargo', 'check', '-p', 'after-done'],
            cwd: fixture.ws1,
          });
          expect(afterDone.result.waitingFor).toBeUndefined();
          const afterDoneRecord = yield* settled(broker, afterDone.result.ticket);
          expect(afterDoneRecord.status).toBe('done');
          expect(afterDoneRecord.after).toEqual([done.result.ticket]);

          const afterFailed = yield* submit(broker, fixture, {
            after: [done.result.ticket, failed.result.ticket],
            argv: ['cargo', 'check', '-p', 'after-failed'],
            cwd: fixture.ws1,
          });
          const afterFailedRecord = yield* settled(broker, afterFailed.result.ticket);
          expect(afterFailedRecord.status).toBe('failed');
          expect(afterFailedRecord.startedAtMs).toBeNull();
          expect(afterFailedRecord.error).toBe(`prerequisite ${failed.result.ticket} failed`);
        }),
      ).pipe(Effect.provide(layer));
    }));

  it.live('kills a blocked dependent on request and lets the prerequisite finish', () =>
    Effect.gen(function* () {
      const { fixture, layer } = yield* brokerFixture(5);
      yield* Effect.scoped(
        Effect.gen(function* () {
          const broker = yield* Broker;
          const holder = yield* submit(broker, fixture, {
            argv: ['cargo', 'check', '-p', 'holder'],
            cwd: fixture.ws1,
            sleep: '0.4',
          });
          yield* Deferred.await(holder.started);
          const prerequisite = yield* submit(broker, fixture, {
            argv: ['cargo', 'build', '--workspace'],
            cwd: fixture.ws1,
          });
          const dependent = yield* submit(broker, fixture, {
            after: [prerequisite.result.ticket],
            argv: ['cargo', 'check', '-p', 'dependent'],
            cwd: fixture.ws1,
          });
          expect(yield* broker.kill(dependent.result.ticket)).toBe(true);
          const killed = yield* settled(broker, dependent.result.ticket);
          expect(killed.status).toBe('killed');
          expect(killed.startedAtMs).toBeNull();
          expect((yield* settled(broker, prerequisite.result.ticket)).status).toBe('done');
          yield* Deferred.await(holder.exited);
        }),
      ).pipe(Effect.provide(layer));
    }));

  it.live('names the tickets ahead in the lane on the acknowledgement', () =>
    Effect.gen(function* () {
      const { fixture, layer } = yield* brokerFixture(5);
      yield* Effect.scoped(
        Effect.gen(function* () {
          const broker = yield* Broker;
          const holder = yield* submit(broker, fixture, {
            argv: ['cargo', 'check', '-p', 'holder'],
            cwd: fixture.ws1,
            sleep: '0.3',
          });
          yield* Deferred.await(holder.started);
          const queued = yield* submit(broker, fixture, {
            argv: ['cargo', 'check', '-p', 'queued-behind'],
            cwd: fixture.ws1,
          });
          expect(queued.result.position).toBe(1);
          expect(queued.result.ahead).toEqual([holder.result.ticket]);
          expect(queued.result.waitEtaMs ?? 0).toBeGreaterThan(0);
          yield* Deferred.await(queued.exited);
        }),
      ).pipe(Effect.provide(layer));
    }));
});
