import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
    });
  });

  it('strips ANSI from tails and diagnostics persisted by pre-strip versions', () => {
    withLedger((ledger) => {
      Effect.runSync(ledger.createRequest(makeInput()));
      Effect.runSync(
        ledger.markFinished(1, {
          atMs: 4_200,
          diagnostics: ['\u001b[1m\u001b[38;5;9merror[E0432]\u001b[0m: unresolved import\n'],
          errorCount: 1,
          exitCode: 101,
          outputTail: 'import: `rusqlite::Connection`\u001b[0m\n \u001b[1m\u001b[94m--> \u001b[0msrc/lib.rs:3:5\n',
          status: 'failed',
        }),
      );

      const finished = Effect.runSync(ledger.getRequest(1));
      expect(finished?.outputTail).toBe(
        'import: `rusqlite::Connection`\n --> src/lib.rs:3:5\n',
      );
      expect(finished?.diagnostics).toEqual(['error[E0432]: unresolved import\n']);
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
