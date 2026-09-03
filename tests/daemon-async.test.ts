import { join } from 'node:path';

import { NodeServices } from '@effect/platform-node';
import { describe, expect, it } from 'effect-rstest';
import * as Deferred from 'effect/Deferred';
import * as Effect from 'effect/Effect';
import * as Fiber from 'effect/Fiber';
import * as Layer from 'effect/Layer';
import type * as Scope from 'effect/Scope';

import { Broker, BrokerLive } from '../src/daemon/broker.js';
import { DaemonConfig } from '../src/daemon/config.js';
import { requestOverSocket } from '../src/daemon/control.js';
import { CostModel, createCostModel } from '../src/daemon/cost.js';
import { createLedgerApi, Ledger, openLedgerDatabase } from '../src/daemon/ledger.js';
import type { LedgerApi } from '../src/daemon/ledger.js';
import type { AckMessage, AwaitResultMessage, ResultResultMessage } from '../src/daemon/protocol.js';
import { Topology } from '../src/daemon/topology.js';
import { pollReport, scopedDaemon, scopedFixture, shortId } from './harness.js';
import type { Fixture } from './harness.js';

interface BrokerFixture {
  readonly fixture: Fixture;
  readonly ledger: LedgerApi;
  readonly layer: Layer.Layer<Broker>;
}

/** A fixture, an open ledger, and a broker layer over it, all released with the scope. */
const brokerFixture = (
  maxConcurrent: number,
  wrapLedger: (base: LedgerApi) => LedgerApi = (base) => base,
): Effect.Effect<BrokerFixture, never, Scope.Scope> =>
  Effect.gen(function* () {
    const fixture = yield* scopedFixture(maxConcurrent);
    const db = yield* Effect.acquireRelease(
      Effect.sync(() => openLedgerDatabase(fixture.config.databasePath)),
      (database) => Effect.sync(() => database.close()),
    );
    const baseLedger = createLedgerApi(db);
    const ledger = wrapLedger(baseLedger);
    const costModel = createCostModel({
      kacheReader: null,
      seedDurations: baseLedger.recentDurations,
    });
    const layer = BrokerLive.pipe(
      Layer.provideMerge(Layer.succeed(CostModel, costModel)),
      Layer.provideMerge(
        Layer.succeed(Topology, {
          dependencyClosure: () => Effect.succeed(new Set<string>()),
          editedRecently: () => Effect.succeed(false),
        }),
      ),
      Layer.provideMerge(Layer.succeed(Ledger, ledger)),
      Layer.provideMerge(Layer.succeed(DaemonConfig, fixture.config)),
      Layer.provideMerge(NodeServices.layer),
    );
    return { fixture, ledger, layer };
  });

describe('async tickets', () => {
  it.live('removes an interrupted ticket waiter immediately', () =>
    Effect.gen(function* () {
      const { fixture, layer } = yield* brokerFixture(1);
      yield* Effect.scoped(
          Effect.gen(function* () {
            const broker = yield* Broker;
            const submitted = yield* broker.submit(
              {
                argv: ['cargo', 'check'],
                cwd: fixture.ws1,
                env: {
                  CARGO_HAULER_CARGO_BIN: join(fixture.binDir, 'cargo'),
                  FAKE_SLEEP: '10',
                },
              },
              {
                onExit: () => Effect.void,
                onOutput: () => Effect.void,
                onStarted: () => Effect.void,
              },
            );
            const waiting = yield* Effect.forkChild(broker.awaitTicket(submitted.ticket, 60_000));
            yield* Effect.sleep('20 millis');
            const registeredWaiters = yield* broker._testWaiterCount(submitted.ticket);
            expect(registeredWaiters).toBe(1);
            yield* Fiber.interrupt(waiting);
            const remainingWaiters = yield* broker._testWaiterCount(submitted.ticket);
            expect(remainingWaiters).toBe(0);
            yield* broker.kill(submitted.ticket);
          }),
        ).pipe(Effect.provide(layer));
    }));

  it.live('overlays a live output tail on a running ticket instead of staying blind until settlement', () =>
    Effect.gen(function* () {
      const { fixture, layer } = yield* brokerFixture(1);
      const started = Deferred.makeUnsafe<void>();
      yield* Effect.scoped(
          Effect.gen(function* () {
            const broker = yield* Broker;
            const submitted = yield* broker.submit(
              {
                argv: ['cargo', 'check', '-p', 'live-tail'],
                cwd: fixture.ws1,
                env: {
                  CARGO_HAULER_CARGO_BIN: join(fixture.binDir, 'cargo'),
                  FAKE_SLEEP: '10',
                },
              },
              {
                onExit: () => Effect.void,
                onOutput: () => Effect.void,
                onStarted: () => Effect.asVoid(Deferred.succeed(started, undefined)),
              },
            );
            yield* Deferred.await(started);
            // The fake cargo prints its banner before sleeping; give the
            // output pump a beat to land it in the tail buffer.
            yield* Effect.sleep('300 millis');
            const record = yield* broker.getTicket(submitted.ticket);
            expect(record?.status).toBe('running');
            expect(record?.outputTailLive).toBe(true);
            expect(record?.outputTail).toContain('fake-out:check -p live-tail');
            yield* broker.kill(submitted.ticket);
            // After settlement the ledger tail is authoritative again.
            const awaited = yield* broker.awaitTicket(submitted.ticket, 10_000);
            expect(awaited.timedOut).toBe(false);
            const settled = yield* broker.getTicket(submitted.ticket);
            expect(settled?.outputTailLive).not.toBe(true);
          }),
        ).pipe(Effect.provide(layer));
    }));

  it.live('settles running, queued, and attached rows when the broker scope closes', () =>
    Effect.gen(function* () {
      const { fixture, layer, ledger } = yield* brokerFixture(1);
      const started = Deferred.makeUnsafe<void>();
      const callbacks = {
        onExit: () => Effect.void,
        onOutput: () => Effect.void,
        onStarted: () => Effect.asVoid(Deferred.succeed(started, undefined)),
      };
      const tickets: string[] = [];

      yield* Effect.scoped(
          Effect.gen(function* () {
            const broker = yield* Broker;
            const running = yield* broker.submit(
              {
                argv: ['cargo', 'check', '-p', 'running'],
                cwd: fixture.ws1,
                env: {
                  CARGO_HAULER_CARGO_BIN: join(fixture.binDir, 'cargo'),
                  FAKE_SLEEP: '10',
                },
              },
              callbacks,
            );
            tickets.push(running.ticket);
            yield* Deferred.await(started);

            const queued = yield* broker.submit(
              {
                argv: ['cargo', 'check', '-p', 'queued'],
                cwd: fixture.ws2,
                env: {
                  CARGO_HAULER_CARGO_BIN: join(fixture.binDir, 'cargo'),
                },
              },
              callbacks,
            );
            tickets.push(queued.ticket);
            const attached = yield* broker.submit(
              {
                argv: ['cargo', 'check', '-p', 'queued'],
                cwd: fixture.ws2,
                env: {
                  CARGO_HAULER_CARGO_BIN: join(fixture.binDir, 'cargo'),
                },
              },
              callbacks,
            );
            tickets.push(attached.ticket);
            const anotherQueued = yield* broker.submit(
              {
                argv: ['cargo', 'check', '-p', 'another'],
                cwd: fixture.ws2,
                env: {
                  CARGO_HAULER_CARGO_BIN: join(fixture.binDir, 'cargo'),
                },
              },
              callbacks,
            );
            tickets.push(anotherQueued.ticket);

            const waiter = yield* Effect.forkChild(broker.awaitTicket(queued.ticket, 60_000));
            yield* Effect.sleep('20 millis');
            const waiterCount = yield* broker._testWaiterCount();
            expect(waiterCount).toBe(1);
            yield* Fiber.interrupt(waiter);
          }),
        ).pipe(Effect.provide(layer));

      const active = yield* ledger.activeRequests();
      expect(active).toEqual([]);
      const records = yield* Effect.forEach(tickets, (ticket) => ledger.getRequestByTicket(ticket));
      expect(records).toHaveLength(4);
      for (const record of records) {
        expect(record?.status).toBe('killed');
        expect(record?.error).toBe('daemon shutdown');
      }
    }));

  it.live('kills a foreground submission whose connection closed during registration', () =>
    Effect.gen(function* () {
      const { fixture, layer } = yield* brokerFixture(1);
      yield* Effect.scoped(
          Effect.gen(function* () {
            const broker = yield* Broker;
            const submitted = yield* broker.submit(
              {
                argv: ['cargo', 'check'],
                cwd: fixture.ws1,
                env: {
                  CARGO_HAULER_CARGO_BIN: join(fixture.binDir, 'cargo'),
                },
              },
              {
                onExit: () => Effect.void,
                onOutput: () => Effect.void,
                onRegistered: () => Effect.succeed(false),
                onStarted: () => Effect.die(new Error('registration-refused job spawned')),
              },
            );
            const result = yield* broker.awaitTicket(submitted.ticket, 2_000);
            expect(result.record?.status).toBe('killed');
            expect(result.record?.startedAtMs).toBeNull();
          }),
        ).pipe(Effect.provide(layer));
    }));

  it.live('does not lose completion between the await ledger read and waiter registration', () =>
    Effect.gen(function* () {
      const readStarted = Deferred.makeUnsafe<void>();
      const releaseRead = Deferred.makeUnsafe<void>();
      const runStarted = Deferred.makeUnsafe<void>();
      const runFinished = Deferred.makeUnsafe<void>();
      let delayNextRead = false;
      let delayed = false;
      const { fixture, layer } = yield* brokerFixture(1, (baseLedger) => ({
        ...baseLedger,
        getRequestByTicket: (ticket) =>
          Effect.gen(function* () {
            const record = yield* baseLedger.getRequestByTicket(ticket);
            if (delayNextRead && !delayed) {
              delayed = true;
              yield* Deferred.succeed(readStarted, undefined);
              yield* Deferred.await(releaseRead);
            }
            return record;
          }),
      }));

      yield* Effect.scoped(
          Effect.gen(function* () {
            const broker = yield* Broker;
            const submitted = yield* broker.submit(
              {
                argv: ['cargo', 'check'],
                cwd: fixture.ws1,
                env: {
                  CARGO_HAULER_CARGO_BIN: join(fixture.binDir, 'cargo'),
                  FAKE_SLEEP: '0.2',
                },
              },
              {
                onExit: () => Effect.asVoid(Deferred.succeed(runFinished, undefined)),
                onOutput: () => Effect.void,
                onStarted: () => Effect.asVoid(Deferred.succeed(runStarted, undefined)),
              },
            );
            yield* Deferred.await(runStarted);
            delayNextRead = true;
            const awaiting = yield* Effect.forkChild(broker.awaitTicket(submitted.ticket, 5_000));
            yield* Deferred.await(readStarted);
            yield* Deferred.await(runFinished);
            yield* Deferred.succeed(releaseRead, undefined);

            const result = yield* Fiber.join(awaiting).pipe(Effect.timeout('500 millis'));
            expect(result.timedOut).toBe(false);
            expect(result.record?.status).toBe('done');
          }),
        ).pipe(Effect.provide(layer));
    }));

  it.live('keeps a background request after the client disconnects and serves await/result', () =>
      Effect.gen(function* () {
        const fixture = yield* scopedDaemon(5);
        const ackMessages = yield* requestOverSocket({
          isTerminal: (message) => message.type === 'ack' || message.type === 'error',
          message: {
            argv: ['cargo', 'check', '-p', 'bg-probe'],
            background: true,
            cwd: fixture.ws1,
            env: {
              // Bare `cargo` no longer resolves through PATH (shim recursion
              // guard); pin the job at the fixture's fake cargo explicitly.
              CARGO_HAULER_CARGO_BIN: join(fixture.binDir, 'cargo'),
              FAKE_SLEEP: '0.2',
              PATH: `${fixture.binDir}:${process.env.PATH ?? ''}`,
            },
            id: shortId(),
            session: 'sess-bg',
            type: 'exec',
          },
          socketPath: fixture.config.socketPath,
        });
        const ack = ackMessages.find((message): message is AckMessage => message.type === 'ack');
        expect(ack?.ticket).toMatch(/^cc-\d+$/u);
        const ticket = ack?.ticket ?? '';

        const report = yield* pollReport(
          fixture,
          (candidate) =>
            candidate.recent.find((record) => record.ticket === ticket)?.status === 'done',
        );
        expect(report.recent.find((record) => record.ticket === ticket)?.status).toBe('done');

        const resultMessages = yield* requestOverSocket({
          isTerminal: (message) => message.type === 'result-result',
          message: { id: shortId(), ticket, type: 'result' },
          socketPath: fixture.config.socketPath,
        });
        const result = resultMessages.find(
          (message): message is ResultResultMessage => message.type === 'result-result',
        );
        expect(result?.request?.status).toBe('done');

        const awaited = yield* requestOverSocket({
          isTerminal: (message) => message.type === 'await-result',
          message: { id: shortId(), maxWaitMs: 1_000, ticket, type: 'await' },
          socketPath: fixture.config.socketPath,
        });
        const awaitResult = awaited.find(
          (message): message is AwaitResultMessage => message.type === 'await-result',
        );
        expect(awaitResult?.timedOut).toBe(false);
        expect(awaitResult?.request?.ticket).toBe(ticket);
      }));
});
