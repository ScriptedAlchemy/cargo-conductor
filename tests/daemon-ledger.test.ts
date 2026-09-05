import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { describe, expect, it } from 'effect-rstest';
import * as Effect from 'effect/Effect';
import type * as Scope from 'effect/Scope';

import {
  createLedgerApi,
  openLedgerDatabase,
} from '../src/daemon/ledger.js';
import type { CreateRequestInput, LedgerApi } from '../src/daemon/ledger.js';
import { scopedDatabase, scopedTempDir } from './harness.js';

const scopedLedger: Effect.Effect<LedgerApi, never, Scope.Scope> = Effect.gen(function* () {
  const directory = yield* scopedTempDir('cc-ledger-');
  const db = yield* scopedDatabase(() => openLedgerDatabase(join(directory, 'state', 'ledger.db')));
  return createLedgerApi(db);
});

const makeInput = (overrides: Partial<CreateRequestInput> = {}): CreateRequestInput => ({
  createdAtMs: 1_000,
  session: 'session-a',
  host: 'claude',
  cwd: '/repo/crates/alpha',
  workspaceRoot: '/repo',
  targetDir: '/repo/target',
  laneKey: '/repo::/repo/target',
  argv: ['cargo', 'check'],
  intentKey: 'intent-a',
  intentJson: '{"subcommand":"check"}',
  ...overrides,
});

const settleLeader = (
  ledger: LedgerApi,
  input: {
    readonly createdAtMs: number;
    readonly queuedAtMs?: number;
    readonly startedAtMs: number;
    readonly finishedAtMs: number;
    readonly status: 'done' | 'failed' | 'killed';
    readonly intentJson?: string | null;
  },
): Effect.Effect<string> =>
  Effect.gen(function* () {
    const created = yield* ledger.createRequest(
      makeInput({
        createdAtMs: input.createdAtMs,
        intentJson: input.intentJson === undefined ? '{"subcommand":"check"}' : input.intentJson,
      }),
    );
    if (input.queuedAtMs !== undefined) {
      yield* ledger.markQueued(created.id, input.queuedAtMs);
    }
    yield* ledger.markRunning(created.id, input.startedAtMs);
    yield* ledger.markFinished(created.id, { atMs: input.finishedAtMs, status: input.status });
    return created.ticket;
  });

describe('ledger lifecycle', () => {
  it.effect('creates a request as cc-1 and carries it through to done', () =>
    Effect.gen(function* () {
      const ledger = yield* scopedLedger;
      const created = yield* ledger.createRequest(makeInput());
      expect(created).toEqual({ id: 1, ticket: 'cc-1' });

      const requested = yield* ledger.getRequest(1);
      expect(requested?.status).toBe('requested');
      expect(requested?.ticket).toBe('cc-1');
      expect(requested?.queuedAtMs).toBeNull();
      expect(requested?.intentJson).toBe('{"subcommand":"check"}');

      yield* ledger.markQueued(1, 1_200);
      yield* ledger.markRunning(1, 1_700);
      yield* ledger.markFinished(1, {
        atMs: 4_200,
        exitCode: 0,
        outputTail: 'Finished dev [unoptimized] target(s)\n',
        status: 'done',
      });

      const finished = yield* ledger.getRequest(1);
      expect(finished).not.toBeNull();
      expect(finished?.status).toBe('done');
      expect(finished?.queuedAtMs).toBe(1_200);
      expect(finished?.startedAtMs).toBe(1_700);
      expect(finished?.finishedAtMs).toBe(4_200);
      expect(finished?.waitMs).toBe(500);
      expect(finished?.runMs).toBe(2_500);
      expect(finished?.exitCode).toBe(0);
      expect(finished?.signal).toBeNull();
      expect(finished?.error).toBeNull();
      expect(finished?.outputTail).toBe('Finished dev [unoptimized] target(s)\n');
      expect(finished?.savedComputeMs).toBeNull();
      expect(finished?.savedComputeSource).toBeNull();
      expect(finished?.savedLatencyMs).toBeNull();
    }));

  it.effect('never reopens a settled row through late attach or running writes', () =>
    Effect.gen(function* () {
      const ledger = yield* scopedLedger;
      yield* ledger.createRequest(makeInput());
      yield* ledger.markFinished(1, { atMs: 4_200, exitCode: 0, status: 'done' });

      // A follower registered as its leader exits: the leader's settlement
      // writes `done` first, then the attach follow-up lands.
      yield* ledger.markAttached(1, { atMs: 4_300, leaderTicket: 'cc-9', mode: 'identity' });
      yield* ledger.markRunning(1, 4_400);

      const settled = yield* ledger.getRequest(1);
      expect(settled?.status).toBe('done');
      expect(settled?.attachedTo).toBeNull();
      expect(settled?.finishedAtMs).toBe(4_200);
      expect((yield* ledger.transitionsFor(1)).map((transition) => transition.toStatus)).toEqual([
        'requested',
        'done',
      ]);
    }));

  it.effect('records every transition in order', () =>
    Effect.gen(function* () {
      const ledger = yield* scopedLedger;
      yield* ledger.createRequest(makeInput());
      yield* ledger.markQueued(1, 1_200);
      yield* ledger.markRunning(1, 1_700);
      yield* ledger.markFinished(1, { atMs: 4_200, exitCode: 0, status: 'done' });

      expect(yield* ledger.transitionsFor(1)).toEqual([
        { atMs: 1_000, fromStatus: null, requestId: 1, toStatus: 'requested' },
        { atMs: 1_200, fromStatus: 'requested', requestId: 1, toStatus: 'queued' },
        { atMs: 1_700, fromStatus: 'queued', requestId: 1, toStatus: 'running' },
        { atMs: 4_200, fromStatus: 'running', requestId: 1, toStatus: 'done' },
      ]);
    }));

  it.effect('keeps an attached request queued until its leader starts', () =>
    Effect.gen(function* () {
      const ledger = yield* scopedLedger;
      yield* ledger.createRequest(makeInput());
      yield* ledger.markAttached(1, {
        atMs: 1_200,
        leaderTicket: 'cc-99',
        mode: 'identity',
      });

      const attached = yield* ledger.getRequest(1);
      expect(attached?.status).toBe('queued');
      expect(attached?.queuedAtMs).toBe(1_000);
      expect(attached?.startedAtMs).toBeNull();
      expect(attached?.waitMs).toBeNull();
      expect(attached?.attachedTo).toBe('cc-99');

      yield* ledger.markRunning(1, 1_700);
      yield* ledger.markFinished(1, { atMs: 4_200, exitCode: 0, status: 'done' });

      const finished = yield* ledger.getRequest(1);
      expect(finished?.startedAtMs).toBe(1_700);
      expect(finished?.waitMs).toBe(700);
      expect(finished?.runMs).toBe(2_500);
      const transitions = yield* ledger.transitionsFor(1);
      expect(transitions.map((transition) => transition.toStatus)).toEqual([
        'requested',
        'queued',
        'running',
        'done',
      ]);
    }));

  it.effect('stores a failed finish with its exit code and error', () =>
    Effect.gen(function* () {
      const ledger = yield* scopedLedger;
      yield* ledger.createRequest(makeInput());
      yield* ledger.markQueued(1, 1_100);
      yield* ledger.markRunning(1, 1_500);
      yield* ledger.markFinished(1, {
        atMs: 2_500,
        error: 'compilation failed',
        exitCode: 101,
        outputTail: 'error[E0308]: mismatched types',
        status: 'failed',
      });

      const record = yield* ledger.getRequest(1);
      expect(record?.status).toBe('failed');
      expect(record?.exitCode).toBe(101);
      expect(record?.runMs).toBe(1_000);
      expect(record?.error).toBe('compilation failed');
      expect(record?.outputTail).toBe('error[E0308]: mismatched types');
    }));

  it.effect('persists scoped diagnostic counts and capped rendered messages', () =>
    Effect.gen(function* () {
      const ledger = yield* scopedLedger;
      yield* ledger.createRequest(makeInput());
      yield* ledger.markQueued(1, 1_100);
      yield* ledger.markRunning(1, 1_500);
      yield* ledger.markFinished(1, {
        atMs: 2_500,
        diagnostics: ['error[E0308]: mismatched types', 'warning: unused import'],
        errorCount: 1,
        exitCode: 101,
        status: 'failed',
        warningCount: 1,
      });

      const record = yield* ledger.getRequest(1);
      expect(record?.errorCount).toBe(1);
      expect(record?.warningCount).toBe(1);
      expect(record?.diagnostics).toEqual([
        'error[E0308]: mismatched types',
        'warning: unused import',
      ]);
    }));

  it.effect('persists follower savings fields written at settlement', () =>
    Effect.gen(function* () {
      const ledger = yield* scopedLedger;
      yield* ledger.createRequest(makeInput());
      yield* ledger.markAttached(1, {
        atMs: 1_100,
        leaderTicket: 'cc-99',
        mode: 'coverage',
      });
      yield* ledger.markRunning(1, 1_500);
      yield* ledger.markFinished(1, {
        atMs: 2_700,
        savedComputeMs: 1_200,
        savedComputeSource: 'estimate',
        savedLatencyMs: -500,
        status: 'done',
      });
      const record = yield* ledger.getRequest(1);
      expect(record?.savedComputeMs).toBe(1_200);
      expect(record?.savedComputeSource).toBe('estimate');
      expect(record?.savedLatencyMs).toBe(-500);
    }));

  it.effect('leaves runMs null when a request is killed before it started', () =>
    Effect.gen(function* () {
      const ledger = yield* scopedLedger;
      yield* ledger.createRequest(makeInput());
      yield* ledger.markQueued(1, 1_100);
      yield* ledger.markFinished(1, { atMs: 1_900, signal: 'SIGKILL', status: 'killed' });

      const record = yield* ledger.getRequest(1);
      expect(record?.status).toBe('killed');
      expect(record?.startedAtMs).toBeNull();
      expect(record?.runMs).toBeNull();
      expect(record?.signal).toBe('SIGKILL');
      expect(record?.exitCode).toBeNull();
      const transitions = yield* ledger.transitionsFor(1);
      expect(transitions.at(-1)).toEqual({
        atMs: 1_900,
        fromStatus: 'queued',
        requestId: 1,
        toStatus: 'killed',
      });
    }));
});

describe('terminal attempts', () => {
  it.effect('creates denied and passthrough rows directly in terminal states', () =>
    Effect.gen(function* () {
      const ledger = yield* scopedLedger;
      const denied = yield* ledger.recordAttempt({
        argv: ['cargo', 'clean'],
        atMs: 1_000,
        cwd: '/repo',
        error: 'blocked while builds are active',
        host: 'cursor',
        session: 'session-a',
        status: 'denied',
      });
      const passthrough = yield* ledger.recordAttempt({
        argv: ['cargo', 'build'],
        atMs: 2_000,
        cwd: '/repo',
        exitCode: 17,
        host: 'codex',
        session: 'session-b',
        sourceAttemptId: 'attempt-1',
        status: 'passthrough',
      });

      expect(yield* ledger.getRequest(denied.id)).toEqual(
        expect.objectContaining({
          argv: ['cargo', 'clean'],
          error: 'blocked while builds are active',
          status: 'denied',
        }),
      );
      expect(yield* ledger.getRequest(passthrough.id)).toEqual(
        expect.objectContaining({
          argv: ['cargo', 'build'],
          exitCode: 17,
          status: 'passthrough',
        }),
      );
      expect(yield* ledger.transitionsFor(denied.id)).toEqual([
        { atMs: 1_000, fromStatus: null, requestId: denied.id, toStatus: 'denied' },
      ]);
    }));
});

describe('exec argv provenance', () => {
  it.effect('round-trips the spawned invocation recorded at run start', () =>
    Effect.gen(function* () {
      const ledger = yield* scopedLedger;
      const created = yield* ledger.createRequest(makeInput({ argv: ['cargo', 'check', '-p', 'aa'] }));
      yield* ledger.markQueued(created.id, 1_200);
      const spawned = [
        'cargo',
        'check',
        '-p',
        'aa',
        '-p',
        'bb',
        '--message-format=json-diagnostic-rendered-ansi',
      ];
      yield* ledger.markRunning(created.id, 1_700, spawned);
      const record = yield* ledger.getRequest(created.id);
      expect(record?.argv).toEqual(['cargo', 'check', '-p', 'aa']);
      expect(record?.execArgv).toEqual(spawned);
    }));

  it.effect('leaves execArgv null for requests that never ran', () =>
    Effect.gen(function* () {
      const ledger = yield* scopedLedger;
      const created = yield* ledger.createRequest(makeInput());
      const record = yield* ledger.getRequest(created.id);
      expect(record?.execArgv).toBeNull();
      expect(record?.outputPath).toBeNull();
    }));
});

describe('output path provenance (#68)', () => {
  it.effect('records the full-output log path at run start and keeps it through settlement', () =>
    Effect.gen(function* () {
      const ledger = yield* scopedLedger;
      const created = yield* ledger.createRequest(makeInput());
      yield* ledger.markQueued(created.id, 1_200);
      yield* ledger.markRunning(created.id, 1_700, ['cargo', 'check'], '/state/tickets/cc-1.log');
      expect((yield* ledger.getRequest(created.id))?.outputPath).toBe('/state/tickets/cc-1.log');
      yield* ledger.markFinished(created.id, { atMs: 2_000, exitCode: 0, status: 'done' });
      const finished = yield* ledger.getRequest(created.id);
      expect(finished?.outputPath).toBe('/state/tickets/cc-1.log');
      // Status rows omit the tail blob but still carry the path.
      expect((yield* ledger.recentStatusRequests(5))[0]?.outputPath).toBe(
        '/state/tickets/cc-1.log',
      );
    }));

  it.effect('points an attached follower at the leader log it shared', () =>
    Effect.gen(function* () {
      const ledger = yield* scopedLedger;
      const leader = yield* ledger.createRequest(makeInput({ createdAtMs: 1_000 }));
      const follower = yield* ledger.createRequest(makeInput({ createdAtMs: 1_100 }));
      yield* ledger.markAttached(follower.id, {
        atMs: 1_150,
        leaderTicket: leader.ticket,
        mode: 'identity',
      });
      yield* ledger.markRunning(leader.id, 1_200, ['cargo', 'check'], '/state/tickets/cc-1.log');
      yield* ledger.markRunning(follower.id, 1_200, undefined, '/state/tickets/cc-1.log');
      expect((yield* ledger.getRequest(follower.id))?.outputPath).toBe('/state/tickets/cc-1.log');
    }));

  it.effect('answers hasRequest for present, pruned, and never-created ids', () =>
    Effect.gen(function* () {
      const ledger = yield* scopedLedger;
      const created = yield* ledger.createRequest(makeInput());
      expect(yield* ledger.hasRequest(created.id)).toBe(true);
      expect(yield* ledger.hasRequest(created.id + 1)).toBe(false);
      yield* ledger.markFinished(created.id, { atMs: 2_000, exitCode: 0, status: 'done' });
      yield* ledger.pruneRetention({ maxRows: 0, nowMs: 100 * 86_400_000, retentionDays: 1 });
      expect(yield* ledger.hasRequest(created.id)).toBe(false);
    }));
});

describe('ledger queries', () => {
  it.effect('returns only compact completed background rows for one session since the cutoff', () =>
    Effect.gen(function* () {
      const ledger = yield* scopedLedger;
      const early = yield* ledger.createRequest(
        makeInput({
          background: true,
          createdAtMs: 1_000,
          session: 'session-a',
          intentJson: '{"large":"value"}',
        }),
      );
      const matching = yield* ledger.createRequest(
        makeInput({
          background: true,
          createdAtMs: 2_000,
          session: 'session-a',
          intentJson: '{"large":"value"}',
        }),
      );
      // A foreground ticket streamed its exit to the shell the agent watched;
      // the afterTool notification must not ask for its result again.
      const foreground = yield* ledger.createRequest(
        makeInput({ createdAtMs: 2_200, session: 'session-a' }),
      );
      const otherSession = yield* ledger.createRequest(
        makeInput({ background: true, createdAtMs: 3_000, session: 'session-b' }),
      );
      yield* ledger.markFinished(early.id, {
        atMs: 2_050,
        outputTail: 'large early tail',
        status: 'done',
      });
      yield* ledger.markFinished(matching.id, {
        atMs: 2_500,
        error: 'compile failed',
        errorCount: 2,
        exitCode: 101,
        outputTail: 'large matching tail',
        status: 'failed',
        warningCount: 3,
      });
      yield* ledger.markFinished(foreground.id, { atMs: 2_600, exitCode: 0, status: 'done' });
      yield* ledger.markFinished(otherSession.id, {
        atMs: 3_500,
        outputTail: 'other session tail',
        status: 'done',
      });

      const completed = yield* ledger.sessionCompleted('session-a', 2_100);
      expect(completed).toEqual([
        {
          error: 'compile failed',
          errorCount: 2,
          exitCode: 101,
          status: 'failed',
          ticket: matching.ticket,
          warningCount: 3,
        },
      ]);
      expect('outputTail' in (completed[0] ?? {})).toBe(false);
      expect('intentJson' in (completed[0] ?? {})).toBe(false);
    }));

  it.effect('reports a foreground ticket once the client detached from it', () =>
    Effect.gen(function* () {
      const ledger = yield* scopedLedger;
      const converted = yield* ledger.createRequest(
        makeInput({ createdAtMs: 1_000, holdStop: true, session: 'session-a' }),
      );
      const watched = yield* ledger.createRequest(
        makeInput({ createdAtMs: 1_100, holdStop: true, session: 'session-a' }),
      );
      expect(yield* ledger.markDetached(converted.id)).toBe(true);
      expect(yield* ledger.markDetached(9_999)).toBe(false);
      yield* ledger.markFinished(converted.id, { atMs: 2_000, exitCode: 0, status: 'done' });
      yield* ledger.markFinished(watched.id, { atMs: 2_000, exitCode: 0, status: 'done' });

      const record = yield* ledger.getRequest(converted.id);
      expect(record?.background).toBe(true);
      // Detaching converts delivery, not the stop-hold: the agent still has
      // not seen this result, so the stop route keeps waiting for it.
      expect(record?.holdStop).toBe(true);
      const completed = yield* ledger.sessionCompleted('session-a', 0);
      expect(completed.map((row) => row.ticket)).toEqual([converted.ticket]);
    }));

  it.effect('returns only compact hold-stop pending rows for one session', () =>
    Effect.gen(function* () {
      const ledger = yield* scopedLedger;
      const matching = yield* ledger.createRequest(
        makeInput({
          createdAtMs: 1_000,
          estimateMs: 4_000,
          holdStop: true,
          session: 'session-a',
        }),
      );
      yield* ledger.markQueued(matching.id, 1_100);
      yield* ledger.createRequest(
        makeInput({ createdAtMs: 2_000, holdStop: false, session: 'session-a' }),
      );
      yield* ledger.createRequest(
        makeInput({ createdAtMs: 3_000, holdStop: true, session: 'session-b' }),
      );

      expect(yield* ledger.sessionPending('session-a')).toEqual([
        {
          createdAtMs: 1_000,
          estimateMs: 4_000,
          holdStop: true,
          startedAtMs: null,
          status: 'queued',
          ticket: matching.ticket,
        },
      ]);
    }));

  it.effect('returns recent requests newest first and honors the limit', () =>
    Effect.gen(function* () {
      const ledger = yield* scopedLedger;
      yield* ledger.createRequest(makeInput({ createdAtMs: 1_000, laneKey: 'a' }));
      yield* ledger.createRequest(makeInput({ createdAtMs: 3_000, laneKey: 'b' }));
      yield* ledger.createRequest(makeInput({ createdAtMs: 2_000, laneKey: 'c' }));

      const recentTen = yield* ledger.recentRequests(10);
      expect(recentTen.map((record) => record.laneKey)).toEqual(['b', 'c', 'a']);
      const recentTwo = yield* ledger.recentRequests(2);
      expect(recentTwo.map((record) => record.ticket)).toEqual(['cc-2', 'cc-3']);
    }));

  it.effect('breaks recent-request ties by newest id', () =>
    Effect.gen(function* () {
      const ledger = yield* scopedLedger;
      yield* ledger.createRequest(makeInput({ createdAtMs: 5_000 }));
      yield* ledger.createRequest(makeInput({ createdAtMs: 5_000 }));

      const recent = yield* ledger.recentRequests(5);
      expect(recent.map((record) => record.id)).toEqual([2, 1]);
    }));

  it.effect('lists only active requests, oldest first', () =>
    Effect.gen(function* () {
      const ledger = yield* scopedLedger;
      yield* ledger.createRequest(makeInput({ createdAtMs: 3_000 }));
      yield* ledger.createRequest(makeInput({ createdAtMs: 1_000 }));
      yield* ledger.createRequest(makeInput({ createdAtMs: 2_000 }));
      yield* ledger.markQueued(2, 1_100);
      yield* ledger.markQueued(3, 2_100);
      yield* ledger.markRunning(3, 2_200);
      yield* ledger.createRequest(makeInput({ createdAtMs: 500 }));
      yield* ledger.markFinished(4, { atMs: 600, exitCode: 0, status: 'done' });

      const active = yield* ledger.activeRequests();
      expect(active.map((record) => record.id)).toEqual([2, 3, 1]);
      expect(active.map((record) => record.status)).toEqual(['queued', 'running', 'requested']);
    }));

  it.effect('looks up requests by ticket and returns null for unknown ones', () =>
    Effect.gen(function* () {
      const ledger = yield* scopedLedger;
      yield* ledger.createRequest(makeInput());

      expect((yield* ledger.getRequestByTicket('cc-1'))?.id).toBe(1);
      expect(yield* ledger.getRequestByTicket('cc-999')).toBeNull();
      expect(yield* ledger.getRequestByTicket('nope')).toBeNull();
      expect(yield* ledger.getRequestByTicket('')).toBeNull();
      expect(yield* ledger.getRequest(42)).toBeNull();
    }));

  it.effect('round-trips argv containing spaces and unicode', () =>
    Effect.gen(function* () {
      const argv = ['cargo', 'test', '--', '--exact', 'módulo::prueba ✅', 'a "quoted" arg'];
      const ledger = yield* scopedLedger;
      yield* ledger.createRequest(makeInput({ argv }));

      expect((yield* ledger.getRequest(1))?.argv).toEqual(argv);
    }));

  it.effect('aggregates served attachment savings by mode and totals', () =>
    Effect.gen(function* () {
      const ledger = yield* scopedLedger;
      for (let id = 1; id <= 4; id += 1) {
        yield* ledger.createRequest(makeInput({ createdAtMs: 1_000 + id }));
      }
      yield* ledger.markAttached(1, { atMs: 1_200, leaderTicket: 'cc-90', mode: 'identity' });
      yield* ledger.markFinished(1, {
        atMs: 2_000,
        savedComputeMs: 4_000,
        savedComputeSource: 'exact',
        savedLatencyMs: 900,
        status: 'done',
      });
      yield* ledger.markAttached(2, { atMs: 1_200, leaderTicket: 'cc-90', mode: 'coverage' });
      yield* ledger.markFinished(2, {
        atMs: 2_100,
        savedComputeMs: 1_500,
        savedComputeSource: 'estimate',
        savedLatencyMs: -300,
        status: 'failed',
      });
      yield* ledger.markAttached(3, { atMs: 1_200, leaderTicket: 'cc-90', mode: 'batch' });
      yield* ledger.markFinished(3, {
        atMs: 2_200,
        savedComputeMs: 800,
        savedComputeSource: 'estimate',
        savedLatencyMs: 250,
        status: 'done',
      });
      // Served savings absent: this requeued/no-service style row must not count.
      yield* ledger.markAttached(4, { atMs: 1_200, leaderTicket: 'cc-90', mode: 'coverage' });
      yield* ledger.markFinished(4, { atMs: 2_300, status: 'killed' });

      expect(yield* ledger.attachmentSavings()).toEqual({
        byMode: [
          {
            mode: 'identity',
            ridersServed: 1,
            savedComputeMs: 4_000,
            savedComputeExactMs: 4_000,
            savedComputeEstimatedMs: 0,
            savedLatencyMs: 900,
            negativeLatencyRiders: 0,
          },
          {
            mode: 'coverage',
            ridersServed: 1,
            savedComputeMs: 1_500,
            savedComputeExactMs: 0,
            savedComputeEstimatedMs: 1_500,
            savedLatencyMs: -300,
            negativeLatencyRiders: 1,
          },
          {
            mode: 'batch',
            ridersServed: 1,
            savedComputeMs: 800,
            savedComputeExactMs: 0,
            savedComputeEstimatedMs: 800,
            savedLatencyMs: 250,
            negativeLatencyRiders: 0,
          },
        ],
        totals: {
          ridersServed: 3,
          savedComputeMs: 6_300,
          savedComputeExactMs: 4_000,
          savedComputeEstimatedMs: 2_300,
          savedLatencyMs: 850,
          negativeLatencyRiders: 1,
        },
      });
    }));
});

describe('metricsWindow', () => {
  it.effect('reports leader-only windowed metrics with subcommand splits', () =>
    Effect.gen(function* () {
      const ledger = yield* scopedLedger;
      yield* settleLeader(ledger, {
        createdAtMs: 1_000,
        queuedAtMs: 1_050,
        startedAtMs: 1_100,
        finishedAtMs: 1_200,
        status: 'done',
        intentJson: '{"subcommand":"check","profile":"dev"}',
      });
      yield* settleLeader(ledger, {
        createdAtMs: 5_000,
        queuedAtMs: 5_030,
        startedAtMs: 5_080,
        finishedAtMs: 5_380,
        status: 'failed',
        intentJson: '{"subcommand":"test","profile":"test"}',
      });
      yield* settleLeader(ledger, {
        createdAtMs: 7_000,
        queuedAtMs: 7_020,
        startedAtMs: 7_100,
        finishedAtMs: 7_600,
        status: 'killed',
        intentJson: '{"subcommand":"check","profile":"perf"}',
      });
      yield* settleLeader(ledger, {
        createdAtMs: 8_000,
        startedAtMs: 8_100,
        finishedAtMs: 8_300,
        status: 'done',
        intentJson: null,
      });

      // Attached followers can have run_ms but must not count as leader work.
      const attached = yield* ledger.createRequest(
        makeInput({ createdAtMs: 8_500, intentJson: '{"subcommand":"check"}' }),
      );
      yield* ledger.markAttached(attached.id, { atMs: 8_510, leaderTicket: 'cc-999', mode: 'identity' });
      yield* ledger.markRunning(attached.id, 8_700);
      yield* ledger.markFinished(attached.id, { atMs: 9_100, status: 'done' });

      // Never-started rows have no run_ms and must not count.
      const neverStarted = yield* ledger.createRequest(
        makeInput({ createdAtMs: 8_600, intentJson: '{"subcommand":"build"}' }),
      );
      yield* ledger.markQueued(neverStarted.id, 8_620);
      yield* ledger.markFinished(neverStarted.id, { atMs: 8_900, status: 'killed' });

      const windowed = yield* ledger.metricsWindow(5_400);
      expect(windowed).toEqual({
        count: 2,
        done: 1,
        failed: 0,
        killed: 1,
        runP50Ms: 200,
        runP95Ms: 200,
        runMeanMs: 350,
        waitP50Ms: 80,
        waitP95Ms: 80,
        bySubcommand: [
          { subcommand: 'check', profile: 'perf', count: 1, p50Ms: 500, maxMs: 500, phases: null },
          { subcommand: 'unknown', profile: 'dev', count: 1, p50Ms: 200, maxMs: 200, phases: null },
        ],
        runTotalMs: 700,
        waitTotalMs: 80,
        // Nothing else ran while these waited and the ledger was opened
        // without a permit count, so the whole wait is "other".
        waitSplit: { count: 1, laneBoundMs: 0, permitBoundMs: 0, otherMs: 80, permits: null },
        handBack: { leaders: 0, laneReleasedMs: 0 },
      });

      const allTime = yield* ledger.metricsWindow(null);
      expect(allTime).toEqual({
        count: 4,
        done: 2,
        failed: 1,
        killed: 1,
        runP50Ms: 200,
        runP95Ms: 300,
        runMeanMs: 275,
        waitP50Ms: 50,
        waitP95Ms: 50,
        bySubcommand: [
          { subcommand: 'check', profile: 'dev', count: 1, p50Ms: 100, maxMs: 100, phases: null },
          { subcommand: 'check', profile: 'perf', count: 1, p50Ms: 500, maxMs: 500, phases: null },
          { subcommand: 'test', profile: 'test', count: 1, p50Ms: 300, maxMs: 300, phases: null },
          { subcommand: 'unknown', profile: 'dev', count: 1, p50Ms: 200, maxMs: 200, phases: null },
        ],
        runTotalMs: 1_100,
        waitTotalMs: 180,
        waitSplit: { count: 3, laneBoundMs: 0, permitBoundMs: 0, otherMs: 180, permits: null },
        handBack: { leaders: 0, laneReleasedMs: 0 },
      });
    }));

  it.effect('attributes queue wait to lane heads and held permits and splits compile from execution', () =>
    Effect.gen(function* () {
      const directory = yield* scopedTempDir('cc-ledger-split-');
      const db = yield* scopedDatabase(() =>
        openLedgerDatabase(join(directory, 'state', 'ledger.db')),
      );
      const ledger = createLedgerApi(db, { permits: 1 });
      const leader = (laneKey: string, createdAtMs: number, intentJson: string) =>
        ledger.createRequest(makeInput({ createdAtMs, intentJson, laneKey }));

      // A: lane 1, admitted at once; compiles until 1_400, then tests until 1_600.
      const a = yield* leader('/repo::/t1', 1_000, '{"subcommand":"test","profile":"test"}');
      yield* ledger.markQueued(a.id, 1_000);
      yield* ledger.markRunning(a.id, 1_000);
      // B: same lane, waits behind A's compile and starts on the hand-back.
      const b = yield* leader('/repo::/t1', 1_100, '{"subcommand":"check","profile":"dev"}');
      yield* ledger.markQueued(b.id, 1_100);
      // C: another lane, idle; waits only because the single permit is held.
      const c = yield* leader('/repo::/t2', 1_200, '{"subcommand":"check","profile":"dev"}');
      yield* ledger.markQueued(c.id, 1_200);
      yield* ledger.markBuildFinished(a.id, 1_400);
      yield* ledger.markRunning(b.id, 1_400);
      yield* ledger.markFinished(a.id, { atMs: 1_600, status: 'done' });
      yield* ledger.markFinished(b.id, { atMs: 1_700, status: 'done' });
      yield* ledger.markRunning(c.id, 1_700);
      yield* ledger.markFinished(c.id, { atMs: 1_800, status: 'done' });
      // D: nothing running while it waits — scheduling latency, "other".
      const d = yield* leader('/repo::/t2', 1_800, '{"subcommand":"check","profile":"dev"}');
      yield* ledger.markQueued(d.id, 1_800);
      yield* ledger.markRunning(d.id, 1_900);
      yield* ledger.markFinished(d.id, { atMs: 2_000, status: 'done' });

      const report = yield* ledger.metricsWindow(null);
      expect(report.waitTotalMs).toBe(300 + 500 + 100);
      expect(report.waitSplit).toEqual({
        count: 4,
        laneBoundMs: 300,
        permitBoundMs: 500,
        otherMs: 100,
        permits: 1,
      });
      expect(report.handBack).toEqual({ leaders: 1, laneReleasedMs: 200 });
      expect(report.bySubcommand).toEqual([
        { subcommand: 'check', profile: 'dev', count: 3, p50Ms: 100, maxMs: 300, phases: null },
        {
          subcommand: 'test',
          profile: 'test',
          count: 1,
          p50Ms: 600,
          maxMs: 600,
          phases: {
            count: 1,
            compileP50Ms: 400,
            executeP50Ms: 200,
            compileTotalMs: 400,
            executeTotalMs: 200,
          },
        },
      ]);

      // The same attribution feeds every dashboard window from one scan.
      const windows = yield* ledger.metricsWindows(2_500);
      expect(windows.hour.waitSplit).toEqual(report.waitSplit);
      expect(windows.all.handBack).toEqual(report.handBack);
    }));
});

describe('reapOrphans', () => {
  it.effect('kills only the active rows and stamps the boot error', () =>
    Effect.gen(function* () {
      const ledger = yield* scopedLedger;
      yield* ledger.createRequest(makeInput({ createdAtMs: 1_000 }));
      yield* ledger.createRequest(makeInput({ createdAtMs: 2_000 }));
      yield* ledger.createRequest(makeInput({ createdAtMs: 3_000 }));
      yield* ledger.markQueued(2, 2_100);
      yield* ledger.markRunning(2, 2_200);
      yield* ledger.markQueued(3, 3_100);
      yield* ledger.markRunning(3, 3_200);
      yield* ledger.markFinished(3, { atMs: 3_900, exitCode: 0, outputTail: 'ok', status: 'done' });

      expect(yield* ledger.reapOrphans(9_000, 'daemon restarted')).toBe(2);
      expect(yield* ledger.activeRequests()).toEqual([]);

      const reaped = yield* ledger.getRequest(1);
      expect(reaped?.status).toBe('killed');
      expect(reaped?.finishedAtMs).toBe(9_000);
      expect(reaped?.error).toBe('daemon restarted');

      const untouched = yield* ledger.getRequest(3);
      expect(untouched?.status).toBe('done');
      expect(untouched?.finishedAtMs).toBe(3_900);
      expect(untouched?.error).toBeNull();
      expect(untouched?.outputTail).toBe('ok');

      const runningTransitions = yield* ledger.transitionsFor(2);
      expect(runningTransitions.at(-1)).toEqual({
        atMs: 9_000,
        fromStatus: 'running',
        requestId: 2,
        toStatus: 'killed',
      });
      const requestedTransitions = yield* ledger.transitionsFor(1);
      expect(requestedTransitions.at(-1)).toEqual({
        atMs: 9_000,
        fromStatus: 'requested',
        requestId: 1,
        toStatus: 'killed',
      });
    }));

  it.effect('reports zero when nothing is active', () =>
    Effect.gen(function* () {
      const ledger = yield* scopedLedger;
      expect(yield* ledger.reapOrphans(9_000, 'daemon restarted')).toBe(0);
    }));
});

describe('ledger retention', () => {
  const day = 86_400_000;

  it.effect('deletes terminal rows older than the retention window with their transitions', () =>
    Effect.gen(function* () {
      const ledger = yield* scopedLedger;
      const nowMs = 100 * day;
      // Old and finished: pruned.
      yield* settleLeader(ledger, {
        createdAtMs: nowMs - 40 * day,
        startedAtMs: nowMs - 40 * day + 100,
        finishedAtMs: nowMs - 40 * day + 200,
        status: 'done',
      });
      // Old but still active: never pruned by age.
      const active = yield* ledger.createRequest(makeInput({ createdAtMs: nowMs - 40 * day }));
      yield* ledger.markQueued(active.id, nowMs - 40 * day + 50);
      // Recent and finished: kept.
      yield* settleLeader(ledger, {
        createdAtMs: nowMs - 2 * day,
        startedAtMs: nowMs - 2 * day + 100,
        finishedAtMs: nowMs - 2 * day + 200,
        status: 'failed',
      });

      const report = yield* ledger.pruneRetention({ nowMs, retentionDays: 30, maxRows: 0 });
      // requested -> running -> done for the pruned leader.
      expect(report).toEqual({ requests: 1, transitions: 3 });
      expect(yield* ledger.getRequest(1)).toBeNull();
      expect(yield* ledger.transitionsFor(1)).toEqual([]);
      expect((yield* ledger.getRequest(active.id))?.status).toBe('queued');
      expect((yield* ledger.transitionsFor(active.id)).length).toBe(2);
      expect((yield* ledger.getRequest(3))?.status).toBe('failed');
    }));

  it.effect('caps the ledger at the newest rows without touching active work', () =>
    Effect.gen(function* () {
      const ledger = yield* scopedLedger;
      const nowMs = 100 * day;
      // Oldest row of all, yet still running: survives the cap.
      const running = yield* ledger.createRequest(makeInput({ createdAtMs: nowMs - 60_000 }));
      yield* ledger.markQueued(running.id, nowMs - 59_000);
      yield* ledger.markRunning(running.id, nowMs - 58_000);
      for (let index = 0; index < 6; index += 1) {
        yield* settleLeader(ledger, {
          createdAtMs: nowMs - (10 - index) * 1_000,
          startedAtMs: nowMs - (10 - index) * 1_000 + 10,
          finishedAtMs: nowMs - (10 - index) * 1_000 + 20,
          status: 'done',
        });
      }

      const report = yield* ledger.pruneRetention({ nowMs, retentionDays: 0, maxRows: 4 });
      expect(report.requests).toBe(2);
      expect(
        (yield* ledger.recentRequests(100)).map((row) => row.id).sort((a, b) => a - b),
      ).toEqual([1, 4, 5, 6, 7]);
      expect((yield* ledger.getRequest(running.id))?.status).toBe('running');
    }));

  it.effect('is a no-op when both limits are disabled', () =>
    Effect.gen(function* () {
      const ledger = yield* scopedLedger;
      yield* settleLeader(ledger, {
        createdAtMs: 1_000,
        startedAtMs: 1_100,
        finishedAtMs: 1_200,
        status: 'done',
      });
      const report = yield* ledger.pruneRetention({
        nowMs: 1_000 * day,
        retentionDays: 0,
        maxRows: 0,
      });
      expect(report).toEqual({ requests: 0, transitions: 0 });
      expect((yield* ledger.getRequest(1))?.status).toBe('done');
    }));
});

describe('ledger transactions', () => {
  const failTransitionsTo = (db: DatabaseSync, toStatus: string): void => {
    db.exec(
      `CREATE TEMP TRIGGER fail_transition BEFORE INSERT ON transitions
       WHEN NEW.to_status = '${toStatus}'
       BEGIN SELECT RAISE(ABORT, 'transition rejected'); END`,
    );
  };

  it.effect('rolls back markFinished when its transition cannot be recorded', () =>
    Effect.gen(function* () {
      const directory = yield* scopedTempDir('cc-ledger-tx-finish-');
      const db = yield* scopedDatabase(() => openLedgerDatabase(join(directory, 'ledger.db')));
      const ledger = createLedgerApi(db);
      yield* ledger.createRequest(makeInput());
      yield* ledger.markQueued(1, 1_100);
      yield* ledger.markRunning(1, 1_200);
      failTransitionsTo(db, 'done');

      const exit = yield* Effect.exit(
        ledger.markFinished(1, { atMs: 2_000, exitCode: 0, status: 'done' }),
      );
      expect(exit._tag).toBe('Failure');
      expect(db.isTransaction).toBe(false);
      const record = yield* ledger.getRequest(1);
      expect(record?.status).toBe('running');
      expect(record?.finishedAtMs).toBeNull();
    }));

  it.effect('rolls back createRequest so no request row exists without its transition', () =>
    Effect.gen(function* () {
      const directory = yield* scopedTempDir('cc-ledger-tx-create-');
      const db = yield* scopedDatabase(() => openLedgerDatabase(join(directory, 'ledger.db')));
      const ledger = createLedgerApi(db);
      failTransitionsTo(db, 'requested');

      const exit = yield* Effect.exit(ledger.createRequest(makeInput()));
      expect(exit._tag).toBe('Failure');
      expect(db.isTransaction).toBe(false);
      expect(yield* ledger.recentRequests(10)).toEqual([]);
    }));

  it.effect('reaps orphans atomically', () =>
    Effect.gen(function* () {
      const directory = yield* scopedTempDir('cc-ledger-tx-reap-');
      const db = yield* scopedDatabase(() => openLedgerDatabase(join(directory, 'ledger.db')));
      const ledger = createLedgerApi(db);
      yield* ledger.createRequest(makeInput({ createdAtMs: 1_000 }));
      yield* ledger.createRequest(makeInput({ createdAtMs: 2_000 }));
      failTransitionsTo(db, 'killed');

      const exit = yield* Effect.exit(ledger.reapOrphans(9_000, 'daemon restarted'));
      expect(exit._tag).toBe('Failure');
      expect(db.isTransaction).toBe(false);
      expect((yield* ledger.activeRequests()).map((row) => row.status)).toEqual([
        'requested',
        'requested',
      ]);
    }));
});

describe('ledger migrations', () => {
  it.effect('adds the savings columns to a table created before them and round-trips markFinished', () =>
    Effect.gen(function* () {
      const directory = yield* scopedTempDir('cc-ledger-migrate-');
      const databasePath = join(directory, 'ledger.db');
      // The first handle must close before `openLedgerDatabase` migrates the file.
      yield* Effect.scoped(
        Effect.gen(function* () {
          const initial = yield* scopedDatabase(() => new DatabaseSync(databasePath));
          initial.exec(`
            CREATE TABLE requests (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              created_at_ms INTEGER NOT NULL,
              session TEXT,
              host TEXT,
              cwd TEXT NOT NULL,
              workspace_root TEXT NOT NULL,
              target_dir TEXT NOT NULL,
              lane_key TEXT NOT NULL,
              argv_json TEXT NOT NULL,
              intent_key TEXT,
              intent_json TEXT,
              status TEXT NOT NULL,
              queued_at_ms INTEGER,
              started_at_ms INTEGER,
              finished_at_ms INTEGER,
              wait_ms INTEGER,
              run_ms INTEGER,
              exit_code INTEGER,
              signal TEXT,
              output_tail TEXT,
              error TEXT
            );
            CREATE TABLE transitions (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              request_id INTEGER NOT NULL,
              at_ms INTEGER NOT NULL,
              from_status TEXT,
              to_status TEXT NOT NULL
            );
          `);
        }),
      );
      const migrated = yield* scopedDatabase(() => openLedgerDatabase(databasePath));
      const ledger = createLedgerApi(migrated);
      yield* ledger.createRequest(makeInput());
      yield* ledger.markAttached(1, {
        atMs: 1_200,
        leaderTicket: 'cc-9',
        mode: 'identity',
      });
      yield* ledger.markRunning(1, 1_500);
      yield* ledger.markFinished(1, {
        atMs: 2_000,
        savedComputeMs: 500,
        savedComputeSource: 'exact',
        savedLatencyMs: -100,
        status: 'done',
      });
      expect(yield* ledger.getRequest(1)).toEqual(
        expect.objectContaining({
          savedComputeMs: 500,
          savedComputeSource: 'exact',
          savedLatencyMs: -100,
        }),
      );
    }));
});

describe('build-finished stamps', () => {
  it.effect('stamps build_finished once on a running leader and the riders sharing its process', () =>
    Effect.gen(function* () {
      const ledger = yield* scopedLedger;
      const leader = yield* ledger.createRequest(makeInput({ createdAtMs: 1_000 }));
      yield* ledger.markQueued(leader.id, 1_050);
      yield* ledger.markRunning(leader.id, 1_100);
      const rider = yield* ledger.createRequest(makeInput({ createdAtMs: 1_200 }));
      yield* ledger.markAttached(rider.id, {
        atMs: 1_250,
        leaderTicket: leader.ticket,
        mode: 'identity',
      });
      yield* ledger.markRunning(rider.id, 1_100);
      const queued = yield* ledger.createRequest(makeInput({ createdAtMs: 1_300 }));
      yield* ledger.markQueued(queued.id, 1_300);

      yield* ledger.markBuildFinished(leader.id, 1_500);
      yield* ledger.markBuildFinished(leader.id, 1_600);
      yield* ledger.markBuildFinished(queued.id, 1_700);

      expect((yield* ledger.getRequest(leader.id))?.buildFinishedAtMs).toBe(1_500);
      expect((yield* ledger.getRequest(rider.id))?.buildFinishedAtMs).toBe(1_500);
      expect((yield* ledger.getRequest(queued.id))?.buildFinishedAtMs).toBeNull();

      yield* ledger.markFinished(leader.id, { atMs: 2_000, status: 'done' });
      yield* ledger.markBuildFinished(queued.id, 2_100);
      expect((yield* ledger.getRequest(queued.id))?.buildFinishedAtMs).toBeNull();
    }));
});

describe('per-phase history queries', () => {
  it.effect('returns compile/execute splits and omits rows without build_finished', () =>
    Effect.gen(function* () {
      const ledger = yield* scopedLedger;
      const split = yield* ledger.createRequest(
        makeInput({
          createdAtMs: 1_000,
          intentJson: '{"subcommand":"test","packages":["alpha"],"targets":["test:session_suite"]}',
          intentKey: 'intent-split',
        }),
      );
      yield* ledger.markQueued(split.id, 1_050);
      yield* ledger.markRunning(split.id, 1_100);
      yield* ledger.markBuildFinished(split.id, 6_100);
      yield* ledger.markFinished(split.id, { atMs: 21_100, status: 'done' });

      const whole = yield* ledger.createRequest(
        makeInput({
          createdAtMs: 2_000,
          intentJson: '{"subcommand":"test","packages":["alpha"]}',
          intentKey: 'intent-split',
        }),
      );
      yield* ledger.markQueued(whole.id, 2_050);
      yield* ledger.markRunning(whole.id, 2_100);
      yield* ledger.markFinished(whole.id, { atMs: 5_100, status: 'done' });

      expect(yield* ledger.recentDurations('intent-split', 10)).toEqual([3_000, 20_000]);
      expect(yield* ledger.recentPhaseDurations('intent-split', 10)).toEqual([
        { compileMs: 5_000, executeMs: 15_000 },
      ]);
    }));

  it.effect('finds a same-package --test neighbor and skips the excluded intent', () =>
    Effect.gen(function* () {
      const ledger = yield* scopedLedger;
      const neighbor = yield* ledger.createRequest(
        makeInput({
          createdAtMs: 1_000,
          intentJson:
            '{"subcommand":"test","packages":["alpha"],"targets":["test:session_suite"]}',
          intentKey: 'intent-neighbor',
        }),
      );
      yield* ledger.markQueued(neighbor.id, 1_050);
      yield* ledger.markRunning(neighbor.id, 1_100);
      yield* ledger.markFinished(neighbor.id, { atMs: 8_100, status: 'done' });

      const otherCrate = yield* ledger.createRequest(
        makeInput({
          createdAtMs: 1_200,
          intentJson:
            '{"subcommand":"test","packages":["beta"],"targets":["test:session_suite"]}',
          intentKey: 'intent-other-crate',
        }),
      );
      yield* ledger.markQueued(otherCrate.id, 1_250);
      yield* ledger.markRunning(otherCrate.id, 1_300);
      yield* ledger.markFinished(otherCrate.id, { atMs: 9_300, status: 'done' });

      // A split neighbor lends only its compile phase: the shared binary's
      // build, not the tests the other selection ran.
      const splitNeighbor = yield* ledger.createRequest(
        makeInput({
          createdAtMs: 1_400,
          intentJson:
            '{"subcommand":"test","packages":["alpha"],"targets":["test:session_suite"]}',
          intentKey: 'intent-neighbor-exact',
        }),
      );
      yield* ledger.markQueued(splitNeighbor.id, 1_450);
      yield* ledger.markRunning(splitNeighbor.id, 1_500);
      yield* ledger.markBuildFinished(splitNeighbor.id, 4_500);
      yield* ledger.markFinished(splitNeighbor.id, { atMs: 60_500, status: 'done' });

      expect(
        yield* ledger.recentNeighborDurations({
          excludeIntentKey: 'intent-exact',
          limit: 10,
          packageName: 'alpha',
          testTarget: 'test:session_suite',
        }),
      ).toEqual([3_000, 7_000]);
      // The asking intent's own rows are never its neighbor.
      expect(
        yield* ledger.recentNeighborDurations({
          excludeIntentKey: 'intent-neighbor',
          limit: 10,
          packageName: 'alpha',
          testTarget: 'test:session_suite',
        }),
      ).toEqual([3_000]);
      expect(
        yield* ledger.recentNeighborDurations({
          excludeIntentKey: 'intent-neighbor',
          limit: 10,
          packageName: 'alpha',
          testTarget: 'test:other_suite',
        }),
      ).toEqual([]);
    }));
});
