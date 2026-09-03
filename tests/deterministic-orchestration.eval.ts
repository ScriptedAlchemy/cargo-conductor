import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'effect-rstest';
import * as Effect from 'effect/Effect';
import * as Fiber from 'effect/Fiber';

import { createLedgerApi, openLedgerDatabase } from '../src/daemon/ledger.js';
import type {
  AckMessage,
  RequestRecord,
  ServerMessage,
  StatusReport,
  TransitionRecord,
} from '../src/daemon/protocol.js';
import { parseTicket } from '../src/daemon/protocol.js';
import { realCargoBin } from '../src/daemon/real-cargo.js';

import {
  decodeOutput,
  execRequest,
  findExit,
  pollReport,
  scopedDaemon,
} from './harness.js';
import type { Fixture } from './harness.js';

const evalsRoot = join(dirname(fileURLToPath(import.meta.url)), '..', 'evals');
const fixtureWorkspace = join(evalsRoot, 'fixture');
const identityWorkspace = join(evalsRoot, 'fixtures', 'identity');
const coverageWorkspace = join(evalsRoot, 'fixtures', 'coverage-failure');
const foldingWorkspace = join(evalsRoot, 'fixtures', 'folding');
const demuxWorkspace = join(evalsRoot, 'fixtures', 'demux');
const realCargo = realCargoBin({});
const realCargoTimeoutMs = 120_000;

const findAck = (messages: readonly ServerMessage[]): AckMessage => {
  const ack = messages.find((message): message is AckMessage => message.type === 'ack');
  if (ack === undefined) {
    throw new Error(`no ack message in ${JSON.stringify(messages)}`);
  }
  return ack;
};

const requireRecord = (report: StatusReport, ticket: string): RequestRecord => {
  const record = [...report.active, ...report.recent].find(
    (candidate) => candidate.ticket === ticket,
  );
  if (record === undefined) {
    throw new Error(`ledger record ${ticket} missing`);
  }
  return record;
};

const ticketId = (ticket: string): number => {
  const id = parseTicket(ticket);
  if (id === null) {
    throw new Error(`invalid ticket ${ticket}`);
  }
  return id;
};

const transitionsFor = (
  fixture: Fixture,
  ticket: string,
): Effect.Effect<readonly TransitionRecord[]> =>
  Effect.acquireUseRelease(
    Effect.sync(() => openLedgerDatabase(fixture.config.databasePath)),
    (database) => createLedgerApi(database).transitionsFor(ticketId(ticket)),
    (database) => Effect.sync(() => database.close()),
  );

const realCargoEnv = (
  fixture: Fixture,
  targetName: string,
  extra: Readonly<Record<string, string>> = {},
): Readonly<Record<string, string>> => ({
  CARGO_HAULER_CARGO_BIN: realCargo,
  CARGO_NET_OFFLINE: 'true',
  CARGO_TARGET_DIR: join(fixture.root, 'cargo-targets', targetName),
  ...extra,
});

const startFakeBlocker = (
  fixture: Fixture,
  cwd: string,
  targetName: string,
  sleep = '3',
): Effect.Effect<readonly ServerMessage[], unknown> =>
  execRequest(fixture, {
    argv: ['cargo', 'doc', '--workspace'],
    cwd,
    extraEnv: { CARGO_TARGET_DIR: join(fixture.root, 'cargo-targets', targetName) },
    isTerminal: (message) => message.type === 'started',
    sleep,
    timeoutMs: 30_000,
  });

const allDoneReport = (
  fixture: Fixture,
  tickets: readonly string[],
): Effect.Effect<StatusReport, unknown> =>
  pollReport(
    fixture,
    (report) =>
      tickets.every((ticket) =>
        report.recent.some(
          (record) => record.ticket === ticket && record.status === 'done',
        ),
      ),
    600,
  );

describe('deterministic cargo-hauler acceptance evals', () => {
  it.live(
    'coalesces four identical real-cargo checks into exactly one spawn',
    () =>
      Effect.gen(function* () {
        const fixture = yield* scopedDaemon(4);
        const options = {
          argv: ['cargo', 'check', '-p', 'identity-pkg'],
          cwd: identityWorkspace,
          extraEnv: realCargoEnv(fixture, 'identity', {
            CC_EVAL_SLEEP_MS: '3000',
          }),
          timeoutMs: realCargoTimeoutMs,
        } as const;
        const clients = yield* Effect.all(
          [
            execRequest(fixture, options),
            execRequest(fixture, options),
            execRequest(fixture, options),
            execRequest(fixture, options),
          ],
          { concurrency: 'unbounded' },
        );
        const exits = clients.map(findExit);
        for (const exit of exits) {
          expect(exit.status).toBe('done');
          expect(exit.exitCode).toBe(0);
        }

        const outputs = clients.map((messages) => ({
          stderr: decodeOutput(messages, 'stderr'),
          stdout: decodeOutput(messages, 'stdout'),
        }));
        expect(outputs.slice(1)).toEqual([outputs[0], outputs[0], outputs[0]]);

        const report = yield* allDoneReport(
          fixture,
          exits.map((exit) => exit.ticket),
        );
        const records = exits.map((exit) => requireRecord(report, exit.ticket));
        const spawned = records.filter((record) => record.execArgv !== null);
        const attached = records.filter((record) => record.attachMode === 'identity');
        expect(spawned).toHaveLength(1);
        expect(spawned[0]?.attachedTo).toBeNull();
        expect(attached).toHaveLength(3);
        for (const follower of attached) {
          expect(follower.attachedTo).toBe(spawned[0]?.ticket);
          expect(follower.execArgv).toBeNull();
        }
      }),
    180_000,
  );

  it.live(
    'requeues a covered narrow check after its stronger workspace check fails',
    () =>
      Effect.gen(function* () {
        const fixture = yield* scopedDaemon(2);
        const env = realCargoEnv(fixture, 'coverage', {
          CC_EVAL_SLEEP_MS: '3000',
        });
        const broadFiber = yield* Effect.forkChild(
          execRequest(fixture, {
            argv: ['cargo', 'check', '--workspace'],
            cwd: coverageWorkspace,
            extraEnv: env,
            timeoutMs: realCargoTimeoutMs,
          }),
        );
        yield* pollReport(
          fixture,
          (report) =>
            report.active.some(
              (record) =>
                record.status === 'running' && record.argv.includes('--workspace'),
            ),
          600,
        );

        const narrowMessages = yield* execRequest(fixture, {
          argv: ['cargo', 'check', '-p', 'good-crate'],
          cwd: coverageWorkspace,
          extraEnv: env,
          timeoutMs: realCargoTimeoutMs,
        });
        const narrowAck = findAck(narrowMessages);
        expect(narrowAck.attachMode).toBe('coverage');
        expect(narrowMessages.some((message) => message.type === 'requeued')).toBe(true);
        expect(
          narrowMessages.filter((message) => message.type === 'started'),
        ).toHaveLength(2);
        const narrowExit = findExit(narrowMessages);
        expect(narrowExit.status).toBe('done');
        expect(narrowExit.exitCode).toBe(0);

        const broadMessages = yield* Fiber.join(broadFiber);
        const broadExit = findExit(broadMessages);
        expect(broadExit.status).toBe('failed');
        expect(broadExit.exitCode).not.toBe(0);

        const narrowTransitions = yield* transitionsFor(fixture, narrowExit.ticket);
        const broadTransitions = yield* transitionsFor(fixture, broadExit.ticket);
        expect(narrowTransitions.map((transition) => transition.toStatus)).toEqual([
          'requested',
          'queued',
          'running',
          'queued',
          'running',
          'done',
        ]);
        expect(broadTransitions.map((transition) => transition.toStatus)).toEqual([
          'requested',
          'queued',
          'running',
          'failed',
        ]);
        const broadFailedAt = broadTransitions.at(-1)?.atMs;
        const requeuedAt = narrowTransitions[3]?.atMs;
        const standaloneStartedAt = narrowTransitions[4]?.atMs;
        expect(requeuedAt).toBeGreaterThanOrEqual(broadFailedAt ?? Number.POSITIVE_INFINITY);
        expect(standaloneStartedAt).toBeGreaterThanOrEqual(requeuedAt ?? Number.POSITIVE_INFINITY);

        const report = yield* allDoneReport(fixture, [narrowExit.ticket]);
        const narrowRecord = requireRecord(report, narrowExit.ticket);
        const broadRecord = requireRecord(report, broadExit.ticket);
        expect(narrowRecord.execArgv).toContain('good-crate');
        expect(broadRecord.execArgv).toContain('--workspace');
      }),
    180_000,
  );

  it.live(
    'folds three queued package checks into one composite real-cargo spawn',
    () =>
      Effect.gen(function* () {
        const fixture = yield* scopedDaemon(1);
        const targetName = 'check-fold';
        yield* startFakeBlocker(fixture, foldingWorkspace, targetName);
        const env = realCargoEnv(fixture, targetName);
        const packages = ['check-a', 'check-b', 'check-c'] as const;
        // Fork sequentially: under v4, a concurrent Effect.all runs each
        // element on a transient fiber, and forkChild would parent the exec
        // fiber to it — interrupting the request the moment the fork returns.
        const fibers = yield* Effect.all(
          packages.map((packageName) =>
            Effect.forkChild(
              execRequest(fixture, {
                argv: ['cargo', 'check', '-p', packageName],
                cwd: foldingWorkspace,
                extraEnv: env,
                timeoutMs: realCargoTimeoutMs,
              }),
            ),
          ),
        );
        yield* pollReport(
          fixture,
          (report) =>
            packages.every((packageName) =>
              report.active.some(
                (record) =>
                  record.status === 'queued' && record.argv.includes(packageName),
              ),
            ),
          600,
        );
        const clients = yield* Effect.forEach(fibers, Fiber.join, {
          concurrency: 'unbounded',
        });
        const exits = clients.map(findExit);
        for (const exit of exits) {
          expect(exit.status).toBe('done');
          expect(exit.exitCode).toBe(0);
        }

        const report = yield* allDoneReport(
          fixture,
          exits.map((exit) => exit.ticket),
        );
        const records = exits.map((exit) => requireRecord(report, exit.ticket));
        const leaders = records.filter((record) => record.execArgv !== null);
        const followers = records.filter((record) => record.attachMode === 'batch');
        expect(leaders).toHaveLength(1);
        expect(followers).toHaveLength(2);
        for (const packageName of packages) {
          expect(leaders[0]?.execArgv).toContain(packageName);
        }
        for (const follower of followers) {
          expect(follower.attachedTo).toBe(leaders[0]?.ticket);
          expect(follower.execArgv).toBeNull();
        }
      }),
    180_000,
  );

  it.live(
    'folds two real cargo test filters and shares the composite output and exit',
    () =>
      Effect.gen(function* () {
        const fixture = yield* scopedDaemon(1);
        const targetName = 'test-fold';
        yield* startFakeBlocker(fixture, foldingWorkspace, targetName);
        const env = realCargoEnv(fixture, targetName);
        // Fork sequentially (see the composite-check eval above): a
        // concurrent Effect.all would parent these forks to transient
        // element fibers and interrupt them immediately under v4.
        const [alphaFiber, betaFiber] = yield* Effect.all([
          Effect.forkChild(
            execRequest(fixture, {
              argv: ['cargo', 'test', '-p', 'test-pkg', '--', 'alpha_only'],
              cwd: foldingWorkspace,
              extraEnv: env,
              timeoutMs: realCargoTimeoutMs,
            }),
          ),
          Effect.forkChild(
            execRequest(fixture, {
              argv: ['cargo', 'test', '-p', 'test-pkg', '--', 'beta_only'],
              cwd: foldingWorkspace,
              extraEnv: env,
              timeoutMs: realCargoTimeoutMs,
            }),
          ),
        ]);
        yield* pollReport(
          fixture,
          (report) =>
            ['alpha_only', 'beta_only'].every((filter) =>
              report.active.some(
                (record) =>
                  record.status === 'queued' && record.argv.includes(filter),
              ),
            ),
          600,
        );
        const [alpha, beta] = yield* Effect.all(
          [Fiber.join(alphaFiber), Fiber.join(betaFiber)],
          { concurrency: 'unbounded' },
        );
        const alphaExit = findExit(alpha);
        const betaExit = findExit(beta);
        expect(alphaExit.status).toBe('done');
        expect(alphaExit.exitCode).toBe(0);
        expect(betaExit.status).toBe('done');
        expect(betaExit.exitCode).toBe(0);
        for (const messages of [alpha, beta]) {
          const stdout = decodeOutput(messages, 'stdout');
          expect(stdout).toContain('test alpha_only ... ok');
          expect(stdout).toContain('test beta_only ... ok');
        }

        const report = yield* allDoneReport(fixture, [
          alphaExit.ticket,
          betaExit.ticket,
        ]);
        const records = [alphaExit.ticket, betaExit.ticket].map((ticket) =>
          requireRecord(report, ticket),
        );
        const leader = records.find((record) => record.execArgv !== null);
        const follower = records.find((record) => record.attachMode === 'batch');
        expect(leader).toBeDefined();
        expect(follower?.attachedTo).toBe(leader?.ticket);
        expect(follower?.execArgv).toBeNull();
        expect(leader?.execArgv).toContain('--no-fail-fast');
        expect(leader?.execArgv).toContain('alpha_only');
        expect(leader?.execArgv).toContain('beta_only');
        expect(follower?.finishedAtMs).toBe(leader?.finishedAtMs);
        expect(follower?.exitCode).toBe(leader?.exitCode);
      }),
    180_000,
  );

  it.live(
    'releases a fast crate coverage client before the slow workspace leader finishes',
    () =>
      Effect.gen(function* () {
        const fixture = yield* scopedDaemon(2);
        const env = realCargoEnv(fixture, 'demux', {
          CC_EVAL_FAST_SLEEP_MS: '1000',
          CC_EVAL_SLOW_SLEEP_MS: '5000',
        });
        const leaderFiber = yield* Effect.forkChild(
          execRequest(fixture, {
            argv: ['cargo', 'check', '--workspace'],
            cwd: demuxWorkspace,
            extraEnv: env,
            timeoutMs: realCargoTimeoutMs,
          }),
        );
        const running = yield* pollReport(
          fixture,
          (report) =>
            report.active.some(
              (record) =>
                record.status === 'running' && record.argv.includes('--workspace'),
            ),
          600,
        );
        const leaderTicket = running.active.find(
          (record) =>
            record.status === 'running' && record.argv.includes('--workspace'),
        )?.ticket;
        expect(leaderTicket).toBeDefined();

        const followerMessages = yield* execRequest(fixture, {
          argv: ['cargo', 'check', '-p', 'fast-a', '--lib'],
          cwd: demuxWorkspace,
          extraEnv: env,
          timeoutMs: realCargoTimeoutMs,
        });
        const followerExit = findExit(followerMessages);
        expect(followerExit.status).toBe('done');
        expect(followerExit.exitCode).toBe(0);
        expect(findAck(followerMessages).attachMode).toBe('coverage');
        expect(decodeOutput(followerMessages, 'stderr')).toContain('released early');

        const leaderMessages = yield* Fiber.join(leaderFiber);
        const leaderExit = findExit(leaderMessages);
        expect(leaderExit.status).toBe('done');
        const report = yield* allDoneReport(fixture, [
          followerExit.ticket,
          leaderExit.ticket,
        ]);
        const followerRecord = requireRecord(report, followerExit.ticket);
        const leaderRecord = requireRecord(report, leaderExit.ticket);
        expect(followerRecord.attachedTo).toBe(leaderTicket);
        expect(followerRecord.finishedAtMs).not.toBeNull();
        expect(leaderRecord.finishedAtMs).not.toBeNull();
        expect(
          (leaderRecord.finishedAtMs ?? 0) - (followerRecord.finishedAtMs ?? 0),
        ).toBeGreaterThanOrEqual(500);
      }),
    180_000,
  );

  it.live(
    'uses seeded costs to schedule the shortest of three queued jobs first',
    () =>
      Effect.gen(function* () {
        const fixture = yield* scopedDaemon(1);
        const targetName = 'schedule';
        const targetEnv = {
          CARGO_TARGET_DIR: join(fixture.root, 'cargo-targets', targetName),
        };
        const jobs = [
          {
            argv: ['cargo', 'build', '--workspace'] as const,
            name: 'long',
            sleep: '1.4',
          },
          {
            argv: ['cargo', 'check', '--workspace'] as const,
            name: 'medium',
            sleep: '0.7',
          },
          {
            argv: ['cargo', 'fmt'] as const,
            name: 'short',
            sleep: '0.2',
          },
        ] as const;
        for (const job of jobs) {
          const messages = yield* execRequest(fixture, {
            argv: job.argv,
            cwd: fixtureWorkspace,
            extraEnv: targetEnv,
            sleep: job.sleep,
            timeoutMs: 30_000,
          });
          expect(findExit(messages).status).toBe('done');
        }

        yield* startFakeBlocker(fixture, fixtureWorkspace, targetName, '2');
        const fibers = new Map<string, Fiber.Fiber<readonly ServerMessage[], unknown>>();
        for (const job of jobs) {
          const fiber = yield* Effect.forkChild(
            execRequest(fixture, {
              argv: job.argv,
              cwd: fixtureWorkspace,
              extraEnv: targetEnv,
              timeoutMs: 30_000,
            }),
          );
          fibers.set(job.name, fiber);
          yield* pollReport(
            fixture,
            (report) =>
              report.active.some(
                (record) =>
                  record.status === 'queued' &&
                  record.argv.length === job.argv.length &&
                  record.argv.every((argument, index) => argument === job.argv[index]),
              ),
            600,
          );
        }

        const clients = yield* Effect.all(
          jobs.map((job) => {
            const fiber = fibers.get(job.name);
            if (fiber === undefined) {
              return Effect.die(new Error(`missing ${job.name} fiber`));
            }
            return Fiber.join(fiber);
          }),
          { concurrency: 'unbounded' },
        );
        const exits = clients.map(findExit);
        for (const exit of exits) {
          expect(exit.status).toBe('done');
        }
        const report = yield* allDoneReport(
          fixture,
          exits.map((exit) => exit.ticket),
        );
        const records = new Map(
          jobs.map((job, index) => [
            job.name,
            requireRecord(report, exits[index]?.ticket ?? ''),
          ]),
        );
        const short = records.get('short');
        const medium = records.get('medium');
        const long = records.get('long');
        expect(short?.estimateMs ?? Number.POSITIVE_INFINITY).toBeLessThan(
          medium?.estimateMs ?? 0,
        );
        expect(short?.estimateMs ?? Number.POSITIVE_INFINITY).toBeLessThan(
          long?.estimateMs ?? 0,
        );
        expect(short?.startedAtMs ?? Number.POSITIVE_INFINITY).toBeLessThan(
          medium?.startedAtMs ?? 0,
        );
        expect(short?.startedAtMs ?? Number.POSITIVE_INFINITY).toBeLessThan(
          long?.startedAtMs ?? 0,
        );
      }),
    180_000,
  );
});
