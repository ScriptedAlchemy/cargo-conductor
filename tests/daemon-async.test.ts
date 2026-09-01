import { rmSync } from 'node:fs';
import { join } from 'node:path';

import { NodeServices } from '@effect/platform-node';
import { describe, expect, it } from '@rstest/core';
import * as Deferred from 'effect/Deferred';
import * as Effect from 'effect/Effect';
import * as Fiber from 'effect/Fiber';
import * as Layer from 'effect/Layer';

import { Broker, BrokerLive } from '../src/daemon/broker.js';
import { DaemonConfig } from '../src/daemon/config.js';
import { requestOverSocket } from '../src/daemon/control.js';
import { CostModel, createCostModel } from '../src/daemon/cost.js';
import { createLedgerApi, Ledger, openLedgerDatabase } from '../src/daemon/ledger.js';
import type { LedgerApi } from '../src/daemon/ledger.js';
import type { AckMessage, AwaitResultMessage, ResultResultMessage } from '../src/daemon/protocol.js';
import { Topology } from '../src/daemon/topology.js';
import { makeFixture, pollReport, shortId, withDaemon } from './harness.js';

describe('async tickets', () => {
  it('removes an interrupted ticket waiter immediately', async () => {
    const fixture = makeFixture(1);
    const db = openLedgerDatabase(fixture.config.databasePath);
    const baseLedger = createLedgerApi(db);
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
      Layer.provideMerge(Layer.succeed(Ledger, baseLedger)),
      Layer.provideMerge(Layer.succeed(DaemonConfig, fixture.config)),
      Layer.provideMerge(NodeServices.layer),
    );

    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const broker = yield* Broker;
            const submitted = yield* broker.submit(
              {
                argv: ['cargo', 'check'],
                cwd: fixture.ws1,
                env: {
                  CARGO_CONDUCTOR_CARGO_BIN: join(fixture.binDir, 'cargo'),
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
        ).pipe(Effect.provide(layer)),
      );
    } finally {
      db.close();
      rmSync(fixture.root, { force: true, recursive: true });
    }
  });

  it('settles running, queued, and attached rows when the broker scope closes', async () => {
    const fixture = makeFixture(1);
    const db = openLedgerDatabase(fixture.config.databasePath);
    const ledger = createLedgerApi(db);
    const costModel = createCostModel({
      kacheReader: null,
      seedDurations: ledger.recentDurations,
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
    const started = Effect.runSync(Deferred.make<void>());
    const callbacks = {
      onExit: () => Effect.void,
      onOutput: () => Effect.void,
      onStarted: () => Effect.asVoid(Deferred.succeed(started, undefined)),
    };
    const tickets: string[] = [];

    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const broker = yield* Broker;
            const running = yield* broker.submit(
              {
                argv: ['cargo', 'check', '-p', 'running'],
                cwd: fixture.ws1,
                env: {
                  CARGO_CONDUCTOR_CARGO_BIN: join(fixture.binDir, 'cargo'),
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
                  CARGO_CONDUCTOR_CARGO_BIN: join(fixture.binDir, 'cargo'),
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
                  CARGO_CONDUCTOR_CARGO_BIN: join(fixture.binDir, 'cargo'),
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
                  CARGO_CONDUCTOR_CARGO_BIN: join(fixture.binDir, 'cargo'),
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
        ).pipe(Effect.provide(layer)),
      );

      const active = await Effect.runPromise(ledger.activeRequests());
      expect(active).toEqual([]);
      const records = await Promise.all(
        tickets.map((ticket) => Effect.runPromise(ledger.getRequestByTicket(ticket))),
      );
      expect(records).toHaveLength(4);
      for (const record of records) {
        expect(record?.status).toBe('killed');
        expect(record?.error).toBe('daemon shutdown');
      }
    } finally {
      db.close();
      rmSync(fixture.root, { force: true, recursive: true });
    }
  });

  it('kills a foreground submission whose connection closed during registration', async () => {
    const fixture = makeFixture(1);
    const db = openLedgerDatabase(fixture.config.databasePath);
    const ledger = createLedgerApi(db);
    const costModel = createCostModel({
      kacheReader: null,
      seedDurations: ledger.recentDurations,
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

    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const broker = yield* Broker;
            const submitted = yield* broker.submit(
              {
                argv: ['cargo', 'check'],
                cwd: fixture.ws1,
                env: {
                  CARGO_CONDUCTOR_CARGO_BIN: join(fixture.binDir, 'cargo'),
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
        ).pipe(Effect.provide(layer)),
      );
    } finally {
      db.close();
      rmSync(fixture.root, { force: true, recursive: true });
    }
  });

  it('does not lose completion between the await ledger read and waiter registration', async () => {
    const fixture = makeFixture(1);
    const db = openLedgerDatabase(fixture.config.databasePath);
    const baseLedger = createLedgerApi(db);
    const readStarted = Effect.runSync(Deferred.make<void>());
    const releaseRead = Effect.runSync(Deferred.make<void>());
    const runStarted = Effect.runSync(Deferred.make<void>());
    const runFinished = Effect.runSync(Deferred.make<void>());
    let delayNextRead = false;
    let delayed = false;
    const ledger: LedgerApi = {
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
    };
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

    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const broker = yield* Broker;
            const submitted = yield* broker.submit(
              {
                argv: ['cargo', 'check'],
                cwd: fixture.ws1,
                env: {
                  CARGO_CONDUCTOR_CARGO_BIN: join(fixture.binDir, 'cargo'),
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
        ).pipe(Effect.provide(layer)),
      );
    } finally {
      db.close();
      rmSync(fixture.root, { force: true, recursive: true });
    }
  });

  it('keeps a background request after the client disconnects and serves await/result', () =>
    withDaemon(5, (fixture) =>
      Effect.gen(function* () {
        const ackMessages = yield* requestOverSocket({
          isTerminal: (message) => message.type === 'ack' || message.type === 'error',
          message: {
            argv: ['cargo', 'check', '-p', 'bg-probe'],
            background: true,
            cwd: fixture.ws1,
            env: {
              // Bare `cargo` no longer resolves through PATH (shim recursion
              // guard); pin the job at the fixture's fake cargo explicitly.
              CARGO_CONDUCTOR_CARGO_BIN: join(fixture.binDir, 'cargo'),
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
      }),
    ));
});
