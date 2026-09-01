import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { describe, expect, it } from '@rstest/core';
import * as Effect from 'effect/Effect';

import { createLedgerApi, openLedgerDatabase } from '../src/daemon/ledger.js';
import type { CreateRequestInput, LedgerApi } from '../src/daemon/ledger.js';

const withLedger = <A>(use: (ledger: LedgerApi) => A): A => {
  const directory = mkdtempSync(join(tmpdir(), 'cc-ledger-'));
  const db = openLedgerDatabase(join(directory, 'state', 'ledger.db'));
  try {
    return use(createLedgerApi(db));
  } finally {
    db.close();
    rmSync(directory, { force: true, recursive: true });
  }
};

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
): string => {
  const created = Effect.runSync(
    ledger.createRequest(
      makeInput({
        createdAtMs: input.createdAtMs,
        intentJson: input.intentJson === undefined ? '{"subcommand":"check"}' : input.intentJson,
      }),
    ),
  );
  if (input.queuedAtMs !== undefined) {
    Effect.runSync(ledger.markQueued(created.id, input.queuedAtMs));
  }
  Effect.runSync(ledger.markRunning(created.id, input.startedAtMs));
  Effect.runSync(ledger.markFinished(created.id, { atMs: input.finishedAtMs, status: input.status }));
  return created.ticket;
};

describe('ledger lifecycle', () => {
  it('creates a request as cc-1 and carries it through to done', () => {
    withLedger((ledger) => {
      const created = Effect.runSync(ledger.createRequest(makeInput()));
      expect(created).toEqual({ id: 1, ticket: 'cc-1' });

      const requested = Effect.runSync(ledger.getRequest(1));
      expect(requested?.status).toBe('requested');
      expect(requested?.ticket).toBe('cc-1');
      expect(requested?.queuedAtMs).toBeNull();
      expect(requested?.intentJson).toBe('{"subcommand":"check"}');

      Effect.runSync(ledger.markQueued(1, 1_200));
      Effect.runSync(ledger.markRunning(1, 1_700));
      Effect.runSync(
        ledger.markFinished(1, {
          atMs: 4_200,
          exitCode: 0,
          outputTail: 'Finished dev [unoptimized] target(s)\n',
          status: 'done',
        }),
      );

      const finished = Effect.runSync(ledger.getRequest(1));
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
    });
  });

  it('records every transition in order', () => {
    withLedger((ledger) => {
      Effect.runSync(ledger.createRequest(makeInput()));
      Effect.runSync(ledger.markQueued(1, 1_200));
      Effect.runSync(ledger.markRunning(1, 1_700));
      Effect.runSync(ledger.markFinished(1, { atMs: 4_200, exitCode: 0, status: 'done' }));

      expect(Effect.runSync(ledger.transitionsFor(1))).toEqual([
        { atMs: 1_000, fromStatus: null, requestId: 1, toStatus: 'requested' },
        { atMs: 1_200, fromStatus: 'requested', requestId: 1, toStatus: 'queued' },
        { atMs: 1_700, fromStatus: 'queued', requestId: 1, toStatus: 'running' },
        { atMs: 4_200, fromStatus: 'running', requestId: 1, toStatus: 'done' },
      ]);
    });
  });

  it('keeps an attached request queued until its leader starts', () => {
    withLedger((ledger) => {
      Effect.runSync(ledger.createRequest(makeInput()));
      Effect.runSync(
        ledger.markAttached(1, {
          atMs: 1_200,
          leaderTicket: 'cc-99',
          mode: 'identity',
        }),
      );

      const attached = Effect.runSync(ledger.getRequest(1));
      expect(attached?.status).toBe('queued');
      expect(attached?.queuedAtMs).toBe(1_000);
      expect(attached?.startedAtMs).toBeNull();
      expect(attached?.waitMs).toBeNull();
      expect(attached?.attachedTo).toBe('cc-99');

      Effect.runSync(ledger.markRunning(1, 1_700));
      Effect.runSync(ledger.markFinished(1, { atMs: 4_200, exitCode: 0, status: 'done' }));

      const finished = Effect.runSync(ledger.getRequest(1));
      expect(finished?.startedAtMs).toBe(1_700);
      expect(finished?.waitMs).toBe(700);
      expect(finished?.runMs).toBe(2_500);
      expect(Effect.runSync(ledger.transitionsFor(1)).map((transition) => transition.toStatus)).toEqual([
        'requested',
        'queued',
        'running',
        'done',
      ]);
    });
  });

  it('stores a failed finish with its exit code and error', () => {
    withLedger((ledger) => {
      Effect.runSync(ledger.createRequest(makeInput()));
      Effect.runSync(ledger.markQueued(1, 1_100));
      Effect.runSync(ledger.markRunning(1, 1_500));
      Effect.runSync(
        ledger.markFinished(1, {
          atMs: 2_500,
          error: 'compilation failed',
          exitCode: 101,
          outputTail: 'error[E0308]: mismatched types',
          status: 'failed',
        }),
      );

      const record = Effect.runSync(ledger.getRequest(1));
      expect(record?.status).toBe('failed');
      expect(record?.exitCode).toBe(101);
      expect(record?.runMs).toBe(1_000);
      expect(record?.error).toBe('compilation failed');
      expect(record?.outputTail).toBe('error[E0308]: mismatched types');
    });
  });

  it('persists scoped diagnostic counts and capped rendered messages', () => {
    withLedger((ledger) => {
      Effect.runSync(ledger.createRequest(makeInput()));
      Effect.runSync(ledger.markQueued(1, 1_100));
      Effect.runSync(ledger.markRunning(1, 1_500));
      Effect.runSync(
        ledger.markFinished(1, {
          atMs: 2_500,
          diagnostics: ['error[E0308]: mismatched types', 'warning: unused import'],
          errorCount: 1,
          exitCode: 101,
          status: 'failed',
          warningCount: 1,
        }),
      );

      const record = Effect.runSync(ledger.getRequest(1));
      expect(record?.errorCount).toBe(1);
      expect(record?.warningCount).toBe(1);
      expect(record?.diagnostics).toEqual([
        'error[E0308]: mismatched types',
        'warning: unused import',
      ]);
    });
  });

  it('persists follower savings fields written at settlement', () => {
    withLedger((ledger) => {
      Effect.runSync(ledger.createRequest(makeInput()));
      Effect.runSync(
        ledger.markAttached(1, {
          atMs: 1_100,
          leaderTicket: 'cc-99',
          mode: 'coverage',
        }),
      );
      Effect.runSync(ledger.markRunning(1, 1_500));
      Effect.runSync(
        ledger.markFinished(1, {
          atMs: 2_700,
          savedComputeMs: 1_200,
          savedComputeSource: 'estimate',
          savedLatencyMs: -500,
          status: 'done',
        }),
      );
      const record = Effect.runSync(ledger.getRequest(1));
      expect(record?.savedComputeMs).toBe(1_200);
      expect(record?.savedComputeSource).toBe('estimate');
      expect(record?.savedLatencyMs).toBe(-500);
    });
  });

  it('leaves runMs null when a request is killed before it started', () => {
    withLedger((ledger) => {
      Effect.runSync(ledger.createRequest(makeInput()));
      Effect.runSync(ledger.markQueued(1, 1_100));
      Effect.runSync(
        ledger.markFinished(1, { atMs: 1_900, signal: 'SIGKILL', status: 'killed' }),
      );

      const record = Effect.runSync(ledger.getRequest(1));
      expect(record?.status).toBe('killed');
      expect(record?.startedAtMs).toBeNull();
      expect(record?.runMs).toBeNull();
      expect(record?.signal).toBe('SIGKILL');
      expect(record?.exitCode).toBeNull();
      expect(Effect.runSync(ledger.transitionsFor(1)).at(-1)).toEqual({
        atMs: 1_900,
        fromStatus: 'queued',
        requestId: 1,
        toStatus: 'killed',
      });
    });
  });
});

describe('terminal attempts', () => {
  it('creates denied and passthrough rows directly in terminal states', () => {
    withLedger((ledger) => {
      const denied = Effect.runSync(
        ledger.recordAttempt({
          argv: ['cargo', 'clean'],
          atMs: 1_000,
          cwd: '/repo',
          error: 'blocked while builds are active',
          host: 'cursor',
          session: 'session-a',
          status: 'denied',
        }),
      );
      const passthrough = Effect.runSync(
        ledger.recordAttempt({
          argv: ['cargo', 'build'],
          atMs: 2_000,
          cwd: '/repo',
          exitCode: 17,
          host: 'codex',
          session: 'session-b',
          sourceAttemptId: 'attempt-1',
          status: 'passthrough',
        }),
      );

      expect(Effect.runSync(ledger.getRequest(denied.id))).toEqual(
        expect.objectContaining({
          argv: ['cargo', 'clean'],
          error: 'blocked while builds are active',
          status: 'denied',
        }),
      );
      expect(Effect.runSync(ledger.getRequest(passthrough.id))).toEqual(
        expect.objectContaining({
          argv: ['cargo', 'build'],
          exitCode: 17,
          status: 'passthrough',
        }),
      );
      expect(Effect.runSync(ledger.transitionsFor(denied.id))).toEqual([
        { atMs: 1_000, fromStatus: null, requestId: denied.id, toStatus: 'denied' },
      ]);
    });
  });
});

describe('exec argv provenance', () => {
  it('round-trips the spawned invocation recorded at run start', () => {
    withLedger((ledger) => {
      const created = Effect.runSync(
        ledger.createRequest(makeInput({ argv: ['cargo', 'check', '-p', 'aa'] })),
      );
      Effect.runSync(ledger.markQueued(created.id, 1_200));
      const spawned = [
        'cargo',
        'check',
        '-p',
        'aa',
        '-p',
        'bb',
        '--message-format=json-diagnostic-rendered-ansi',
      ];
      Effect.runSync(ledger.markRunning(created.id, 1_700, spawned));
      const record = Effect.runSync(ledger.getRequest(created.id));
      expect(record?.argv).toEqual(['cargo', 'check', '-p', 'aa']);
      expect(record?.execArgv).toEqual(spawned);
    });
  });

  it('leaves execArgv null for requests that never ran', () => {
    withLedger((ledger) => {
      const created = Effect.runSync(ledger.createRequest(makeInput()));
      const record = Effect.runSync(ledger.getRequest(created.id));
      expect(record?.execArgv).toBeNull();
    });
  });
});

describe('ledger queries', () => {
  it('returns only compact completed rows for one session since the cutoff', () => {
    withLedger((ledger) => {
      const early = Effect.runSync(
        ledger.createRequest(
          makeInput({ createdAtMs: 1_000, session: 'session-a', intentJson: '{"large":"value"}' }),
        ),
      );
      const matching = Effect.runSync(
        ledger.createRequest(
          makeInput({ createdAtMs: 2_000, session: 'session-a', intentJson: '{"large":"value"}' }),
        ),
      );
      const otherSession = Effect.runSync(
        ledger.createRequest(makeInput({ createdAtMs: 3_000, session: 'session-b' })),
      );
      Effect.runSync(
        ledger.markFinished(early.id, {
          atMs: 2_050,
          outputTail: 'large early tail',
          status: 'done',
        }),
      );
      Effect.runSync(
        ledger.markFinished(matching.id, {
          atMs: 2_500,
          error: 'compile failed',
          errorCount: 2,
          exitCode: 101,
          outputTail: 'large matching tail',
          status: 'failed',
          warningCount: 3,
        }),
      );
      Effect.runSync(
        ledger.markFinished(otherSession.id, {
          atMs: 3_500,
          outputTail: 'other session tail',
          status: 'done',
        }),
      );

      const completed = Effect.runSync(ledger.sessionCompleted('session-a', 2_100));
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
    });
  });

  it('returns only compact hold-stop pending rows for one session', () => {
    withLedger((ledger) => {
      const matching = Effect.runSync(
        ledger.createRequest(
          makeInput({
            createdAtMs: 1_000,
            estimateMs: 4_000,
            holdStop: true,
            session: 'session-a',
          }),
        ),
      );
      Effect.runSync(ledger.markQueued(matching.id, 1_100));
      Effect.runSync(
        ledger.createRequest(
          makeInput({ createdAtMs: 2_000, holdStop: false, session: 'session-a' }),
        ),
      );
      Effect.runSync(
        ledger.createRequest(
          makeInput({ createdAtMs: 3_000, holdStop: true, session: 'session-b' }),
        ),
      );

      expect(Effect.runSync(ledger.sessionPending('session-a'))).toEqual([
        {
          createdAtMs: 1_000,
          estimateMs: 4_000,
          holdStop: true,
          startedAtMs: null,
          status: 'queued',
          ticket: matching.ticket,
        },
      ]);
    });
  });

  it('returns recent requests newest first and honors the limit', () => {
    withLedger((ledger) => {
      Effect.runSync(ledger.createRequest(makeInput({ createdAtMs: 1_000, laneKey: 'a' })));
      Effect.runSync(ledger.createRequest(makeInput({ createdAtMs: 3_000, laneKey: 'b' })));
      Effect.runSync(ledger.createRequest(makeInput({ createdAtMs: 2_000, laneKey: 'c' })));

      expect(Effect.runSync(ledger.recentRequests(10)).map((record) => record.laneKey)).toEqual([
        'b',
        'c',
        'a',
      ]);
      expect(Effect.runSync(ledger.recentRequests(2)).map((record) => record.ticket)).toEqual([
        'cc-2',
        'cc-3',
      ]);
    });
  });

  it('breaks recent-request ties by newest id', () => {
    withLedger((ledger) => {
      Effect.runSync(ledger.createRequest(makeInput({ createdAtMs: 5_000 })));
      Effect.runSync(ledger.createRequest(makeInput({ createdAtMs: 5_000 })));

      expect(Effect.runSync(ledger.recentRequests(5)).map((record) => record.id)).toEqual([2, 1]);
    });
  });

  it('lists only active requests, oldest first', () => {
    withLedger((ledger) => {
      Effect.runSync(ledger.createRequest(makeInput({ createdAtMs: 3_000 })));
      Effect.runSync(ledger.createRequest(makeInput({ createdAtMs: 1_000 })));
      Effect.runSync(ledger.createRequest(makeInput({ createdAtMs: 2_000 })));
      Effect.runSync(ledger.markQueued(2, 1_100));
      Effect.runSync(ledger.markQueued(3, 2_100));
      Effect.runSync(ledger.markRunning(3, 2_200));
      Effect.runSync(ledger.createRequest(makeInput({ createdAtMs: 500 })));
      Effect.runSync(ledger.markFinished(4, { atMs: 600, exitCode: 0, status: 'done' }));

      const active = Effect.runSync(ledger.activeRequests());
      expect(active.map((record) => record.id)).toEqual([2, 3, 1]);
      expect(active.map((record) => record.status)).toEqual(['queued', 'running', 'requested']);
    });
  });

  it('looks up requests by ticket and returns null for unknown ones', () => {
    withLedger((ledger) => {
      Effect.runSync(ledger.createRequest(makeInput()));

      expect(Effect.runSync(ledger.getRequestByTicket('cc-1'))?.id).toBe(1);
      expect(Effect.runSync(ledger.getRequestByTicket('cc-999'))).toBeNull();
      expect(Effect.runSync(ledger.getRequestByTicket('nope'))).toBeNull();
      expect(Effect.runSync(ledger.getRequestByTicket(''))).toBeNull();
      expect(Effect.runSync(ledger.getRequest(42))).toBeNull();
    });
  });

  it('round-trips argv containing spaces and unicode', () => {
    const argv = ['cargo', 'test', '--', '--exact', 'módulo::prueba ✅', 'a "quoted" arg'];
    withLedger((ledger) => {
      Effect.runSync(ledger.createRequest(makeInput({ argv })));

      expect(Effect.runSync(ledger.getRequest(1))?.argv).toEqual(argv);
    });
  });

  it('aggregates served attachment savings by mode and totals', () => {
    withLedger((ledger) => {
      for (let id = 1; id <= 4; id += 1) {
        Effect.runSync(ledger.createRequest(makeInput({ createdAtMs: 1_000 + id })));
      }
      Effect.runSync(
        ledger.markAttached(1, { atMs: 1_200, leaderTicket: 'cc-90', mode: 'identity' }),
      );
      Effect.runSync(
        ledger.markFinished(1, {
          atMs: 2_000,
          savedComputeMs: 4_000,
          savedComputeSource: 'exact',
          savedLatencyMs: 900,
          status: 'done',
        }),
      );
      Effect.runSync(
        ledger.markAttached(2, { atMs: 1_200, leaderTicket: 'cc-90', mode: 'coverage' }),
      );
      Effect.runSync(
        ledger.markFinished(2, {
          atMs: 2_100,
          savedComputeMs: 1_500,
          savedComputeSource: 'estimate',
          savedLatencyMs: -300,
          status: 'failed',
        }),
      );
      Effect.runSync(
        ledger.markAttached(3, { atMs: 1_200, leaderTicket: 'cc-90', mode: 'batch' }),
      );
      Effect.runSync(
        ledger.markFinished(3, {
          atMs: 2_200,
          savedComputeMs: 800,
          savedComputeSource: 'estimate',
          savedLatencyMs: 250,
          status: 'done',
        }),
      );
      // Served savings absent: this requeued/no-service style row must not count.
      Effect.runSync(
        ledger.markAttached(4, { atMs: 1_200, leaderTicket: 'cc-90', mode: 'coverage' }),
      );
      Effect.runSync(ledger.markFinished(4, { atMs: 2_300, status: 'killed' }));

      expect(Effect.runSync(ledger.attachmentSavings())).toEqual({
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
    });
  });
});

describe('metricsWindow', () => {
  it('reports leader-only windowed metrics with subcommand splits', () => {
    withLedger((ledger) => {
      settleLeader(ledger, {
        createdAtMs: 1_000,
        queuedAtMs: 1_050,
        startedAtMs: 1_100,
        finishedAtMs: 1_200,
        status: 'done',
        intentJson: '{"subcommand":"check"}',
      });
      settleLeader(ledger, {
        createdAtMs: 5_000,
        queuedAtMs: 5_030,
        startedAtMs: 5_080,
        finishedAtMs: 5_380,
        status: 'failed',
        intentJson: '{"subcommand":"test"}',
      });
      settleLeader(ledger, {
        createdAtMs: 7_000,
        queuedAtMs: 7_020,
        startedAtMs: 7_100,
        finishedAtMs: 7_600,
        status: 'killed',
        intentJson: '{"subcommand":"check"}',
      });
      settleLeader(ledger, {
        createdAtMs: 8_000,
        startedAtMs: 8_100,
        finishedAtMs: 8_300,
        status: 'done',
        intentJson: null,
      });

      // Attached followers can have run_ms but must not count as leader work.
      const attached = Effect.runSync(
        ledger.createRequest(makeInput({ createdAtMs: 8_500, intentJson: '{"subcommand":"check"}' })),
      );
      Effect.runSync(
        ledger.markAttached(attached.id, { atMs: 8_510, leaderTicket: 'cc-999', mode: 'identity' }),
      );
      Effect.runSync(ledger.markRunning(attached.id, 8_700));
      Effect.runSync(ledger.markFinished(attached.id, { atMs: 9_100, status: 'done' }));

      // Never-started rows have no run_ms and must not count.
      const neverStarted = Effect.runSync(
        ledger.createRequest(makeInput({ createdAtMs: 8_600, intentJson: '{"subcommand":"build"}' })),
      );
      Effect.runSync(ledger.markQueued(neverStarted.id, 8_620));
      Effect.runSync(ledger.markFinished(neverStarted.id, { atMs: 8_900, status: 'killed' }));

      const windowed = Effect.runSync(ledger.metricsWindow(5_400));
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
          { subcommand: 'check', count: 1, p50Ms: 500, maxMs: 500 },
          { subcommand: 'unknown', count: 1, p50Ms: 200, maxMs: 200 },
        ],
      });

      const allTime = Effect.runSync(ledger.metricsWindow(null));
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
          { subcommand: 'check', count: 2, p50Ms: 100, maxMs: 500 },
          { subcommand: 'test', count: 1, p50Ms: 300, maxMs: 300 },
          { subcommand: 'unknown', count: 1, p50Ms: 200, maxMs: 200 },
        ],
      });
    });
  });
});

describe('reapOrphans', () => {
  it('kills only the active rows and stamps the boot error', () => {
    withLedger((ledger) => {
      Effect.runSync(ledger.createRequest(makeInput({ createdAtMs: 1_000 })));
      Effect.runSync(ledger.createRequest(makeInput({ createdAtMs: 2_000 })));
      Effect.runSync(ledger.createRequest(makeInput({ createdAtMs: 3_000 })));
      Effect.runSync(ledger.markQueued(2, 2_100));
      Effect.runSync(ledger.markRunning(2, 2_200));
      Effect.runSync(ledger.markQueued(3, 3_100));
      Effect.runSync(ledger.markRunning(3, 3_200));
      Effect.runSync(
        ledger.markFinished(3, { atMs: 3_900, exitCode: 0, outputTail: 'ok', status: 'done' }),
      );

      expect(Effect.runSync(ledger.reapOrphans(9_000, 'daemon restarted'))).toBe(2);
      expect(Effect.runSync(ledger.activeRequests())).toEqual([]);

      const reaped = Effect.runSync(ledger.getRequest(1));
      expect(reaped?.status).toBe('killed');
      expect(reaped?.finishedAtMs).toBe(9_000);
      expect(reaped?.error).toBe('daemon restarted');

      const untouched = Effect.runSync(ledger.getRequest(3));
      expect(untouched?.status).toBe('done');
      expect(untouched?.finishedAtMs).toBe(3_900);
      expect(untouched?.error).toBeNull();
      expect(untouched?.outputTail).toBe('ok');

      expect(Effect.runSync(ledger.transitionsFor(2)).at(-1)).toEqual({
        atMs: 9_000,
        fromStatus: 'running',
        requestId: 2,
        toStatus: 'killed',
      });
      expect(Effect.runSync(ledger.transitionsFor(1)).at(-1)).toEqual({
        atMs: 9_000,
        fromStatus: 'requested',
        requestId: 1,
        toStatus: 'killed',
      });
    });
  });

  it('reports zero when nothing is active', () => {
    withLedger((ledger) => {
      expect(Effect.runSync(ledger.reapOrphans(9_000, 'daemon restarted'))).toBe(0);
    });
  });
});

describe('ledger migrations', () => {
  it('backfills savings for riders settled before savings columns were populated', () => {
    const directory = mkdtempSync(join(tmpdir(), 'cc-ledger-savings-backfill-'));
    const databasePath = join(directory, 'ledger.db');
    const initial = openLedgerDatabase(databasePath);
    let followerId = 0;
    try {
      const ledger = createLedgerApi(initial);
      const leader = Effect.runSync(
        ledger.createRequest(makeInput({ createdAtMs: 1_000, estimateMs: 900 })),
      );
      Effect.runSync(ledger.markQueued(leader.id, 1_050));
      Effect.runSync(ledger.markRunning(leader.id, 1_100));
      Effect.runSync(ledger.markFinished(leader.id, { atMs: 2_000, status: 'done' }));
      const follower = Effect.runSync(
        ledger.createRequest(makeInput({ createdAtMs: 1_200, estimateMs: 600 })),
      );
      followerId = follower.id;
      Effect.runSync(
        ledger.markAttached(follower.id, {
          atMs: 1_250,
          leaderTicket: leader.ticket,
          mode: 'identity',
        }),
      );
      Effect.runSync(ledger.markRunning(follower.id, 1_100));
      // Simulates an older daemon that settled the rider without savings.
      Effect.runSync(ledger.markFinished(follower.id, { atMs: 2_000, status: 'done' }));
    } finally {
      initial.close();
    }
    const reopened = openLedgerDatabase(databasePath);
    try {
      const record = Effect.runSync(createLedgerApi(reopened).getRequest(followerId));
      expect(record).toEqual(
        expect.objectContaining({
          savedComputeMs: 900,
          savedComputeSource: 'exact',
          savedLatencyMs: -200,
        }),
      );
    } finally {
      reopened.close();
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it('adds savings columns to a legacy table and round-trips markFinished', () => {
    const directory = mkdtempSync(join(tmpdir(), 'cc-ledger-migrate-'));
    const databasePath = join(directory, 'ledger.db');
    const legacy = new DatabaseSync(databasePath);
    try {
      legacy.exec(`
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
    } finally {
      legacy.close();
    }
    const migrated = openLedgerDatabase(databasePath);
    try {
      const ledger = createLedgerApi(migrated);
      Effect.runSync(ledger.createRequest(makeInput()));
      Effect.runSync(
        ledger.markAttached(1, {
          atMs: 1_200,
          leaderTicket: 'cc-9',
          mode: 'identity',
        }),
      );
      Effect.runSync(ledger.markRunning(1, 1_500));
      Effect.runSync(
        ledger.markFinished(1, {
          atMs: 2_000,
          savedComputeMs: 500,
          savedComputeSource: 'exact',
          savedLatencyMs: -100,
          status: 'done',
        }),
      );
      expect(Effect.runSync(ledger.getRequest(1))).toEqual(
        expect.objectContaining({
          savedComputeMs: 500,
          savedComputeSource: 'exact',
          savedLatencyMs: -100,
        }),
      );
    } finally {
      migrated.close();
      rmSync(directory, { force: true, recursive: true });
    }
  });
});
