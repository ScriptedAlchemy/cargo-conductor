import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from '@rstest/core';
import * as Effect from 'effect/Effect';
import * as Fiber from 'effect/Fiber';
import * as Schedule from 'effect/Schedule';

import { resolveDaemonConfig } from '../src/daemon/config.js';
import type { DaemonConfigShape } from '../src/daemon/config.js';
import { pingDaemon, requestOverSocket } from '../src/daemon/control.js';
import { createLedgerApi, openLedgerDatabase } from '../src/daemon/ledger.js';
import { runDaemon } from '../src/daemon/main.js';
import type {
  AckMessage,
  ErrorMessage,
  ExitMessage,
  KillResultMessage,
  OutputMessage,
  ServerMessage,
  StartedMessage,
  StatusReport,
  StatusResultMessage,
} from '../src/daemon/protocol.js';

const fakeCargoScript = `#!/usr/bin/env bash
echo "fake-out:$*"
echo "fake-err:$*" >&2
if [ -n "\${FAKE_SLEEP:-}" ]; then sleep "\$FAKE_SLEEP"; fi
exit "\${FAKE_EXIT:-0}"
`;

interface Fixture {
  readonly config: DaemonConfigShape;
  readonly root: string;
  readonly binDir: string;
  readonly ws1: string;
  readonly ws2: string;
}

const makeFixture = (maxConcurrent: number): Fixture => {
  const root = mkdtempSync(join(tmpdir(), 'cc-it-'));
  const stateDir = join(root, 'state');
  const binDir = join(root, 'bin');
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(binDir, 'cargo'), fakeCargoScript);
  chmodSync(join(binDir, 'cargo'), 0o755);
  const makeWorkspace = (name: string): string => {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'Cargo.toml'), `[package]\nname = "${name}"\n`);
    return dir;
  };
  const config = resolveDaemonConfig({
    CARGO_CONDUCTOR_STATE_DIR: stateDir,
    CARGO_CONDUCTOR_MAX_CONCURRENT: String(maxConcurrent),
  });
  return { config, root, binDir, ws1: makeWorkspace('ws1'), ws2: makeWorkspace('ws2') };
};

const withDaemon = <A>(
  maxConcurrent: number,
  use: (fixture: Fixture) => Effect.Effect<A, unknown>,
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = makeFixture(maxConcurrent);
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => rmSync(fixture.root, { recursive: true, force: true })),
        );
        yield* Effect.forkScoped(runDaemon(fixture.config));
        yield* pingDaemon(fixture.config.socketPath, 500).pipe(
          Effect.retry(Schedule.spaced('50 millis').pipe(Schedule.intersect(Schedule.recurs(100)))),
        );
        return yield* use(fixture);
      }),
    ),
  );

const shortId = (): string => randomUUID().slice(0, 8);

interface ExecOptions {
  readonly cwd: string;
  readonly argv?: readonly string[];
  readonly sleep?: string;
  readonly exit?: string;
  readonly isTerminal?: (message: ServerMessage) => boolean;
  readonly timeoutMs?: number;
}

const execRequest = (fixture: Fixture, options: ExecOptions) => {
  const env: Record<string, string> = {
    PATH: `${fixture.binDir}:${process.env.PATH ?? ''}`,
  };
  if (options.sleep !== undefined) {
    env.FAKE_SLEEP = options.sleep;
  }
  if (options.exit !== undefined) {
    env.FAKE_EXIT = options.exit;
  }
  return requestOverSocket({
    socketPath: fixture.config.socketPath,
    message: {
      type: 'exec',
      id: shortId(),
      argv: [...(options.argv ?? ['cargo', 'check'])],
      cwd: options.cwd,
      env,
    },
    isTerminal:
      options.isTerminal ??
      ((message) => message.type === 'exit' || message.type === 'error'),
    timeoutMs: options.timeoutMs ?? 8_000,
  });
};

const fetchReport = (fixture: Fixture): Effect.Effect<StatusReport, unknown> =>
  requestOverSocket({
    socketPath: fixture.config.socketPath,
    message: { type: 'status', id: shortId(), limit: 100 },
    isTerminal: (message) => message.type === 'status-result',
  }).pipe(
    Effect.map((messages) => {
      const result = messages.find(
        (message): message is StatusResultMessage => message.type === 'status-result',
      );
      if (result === undefined) {
        throw new Error('status-result missing');
      }
      return result.report;
    }),
  );

const pollReport = (
  fixture: Fixture,
  predicate: (report: StatusReport) => boolean,
  attempts = 60,
): Effect.Effect<StatusReport, unknown> =>
  Effect.gen(function* () {
    const report = yield* fetchReport(fixture);
    if (predicate(report)) {
      return report;
    }
    if (attempts <= 0) {
      return yield* Effect.dieMessage('polled condition never became true');
    }
    yield* Effect.sleep('100 millis');
    return yield* pollReport(fixture, predicate, attempts - 1);
  });

const findExit = (messages: readonly ServerMessage[]): ExitMessage => {
  const exit = messages.find((message): message is ExitMessage => message.type === 'exit');
  if (exit === undefined) {
    throw new Error(`no exit message in ${JSON.stringify(messages)}`);
  }
  return exit;
};

const decodeOutput = (
  messages: readonly ServerMessage[],
  channel: 'stdout' | 'stderr',
): string =>
  messages
    .filter(
      (message): message is OutputMessage =>
        message.type === 'output' && message.channel === channel,
    )
    .map((message) => Buffer.from(message.data, 'base64').toString('utf8'))
    .join('');

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
        expect(record?.outputTail).toContain('fake-out:check');
        expect(record?.intentKey).not.toBeNull();
        expect(record?.targetDir).toBe(join(fixture.ws1, 'target'));
        // An idle lane worker parked in Queue.take must not surface as -1 queued.
        for (const lane of report.lanes) {
          expect(lane.queued).toBeGreaterThanOrEqual(0);
        }

        const db = openLedgerDatabase(fixture.config.databasePath);
        const transitions = yield* createLedgerApi(db).transitionsFor(
          Number(exit.ticket.slice('cc-'.length)),
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

        const [sameLane, otherLane] = yield* Effect.all(
          [
            execRequest(fixture, { cwd: fixture.ws1 }),
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
          sleep: '0.6',
          isTerminal: (message) => message.type === 'started',
        });
        const holderTicket =
          holderMessages.find(
            (message): message is StartedMessage => message.type === 'started',
          )?.ticket ?? '';

        const queuedMessages = yield* execRequest(fixture, {
          cwd: fixture.ws1,
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
