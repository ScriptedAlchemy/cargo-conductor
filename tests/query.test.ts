import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from '@rstest/core';
import * as Effect from 'effect/Effect';
import * as Schedule from 'effect/Schedule';

import { resolveDaemonConfig } from '../src/daemon/config.js';
import { pingDaemon, requestOverSocket } from '../src/daemon/control.js';
import { createLedgerApi, openLedgerDatabase } from '../src/daemon/ledger.js';
import { runDaemon } from '../src/daemon/main.js';
import type { RequestRecord } from '../src/daemon/protocol.js';
import {
  consumerRendersColor,
  describeRequestRecord,
  displayRequestRecord,
  displayRequestRecords,
  loadConductorSnapshot,
} from '../src/query.js';

import { withTempDir } from './harness.js';

describe('ticket summaries', () => {
  it('includes durable diagnostic counts when present', () => {
    expect(
      describeRequestRecord('cc-9', {
        errorCount: 2,
        status: 'failed',
        ticket: 'cc-9',
        warningCount: 3,
      }),
    ).toBe('cc-9 failed (2 errors, 3 warnings)');
    expect(
      describeRequestRecord('cc-10', {
        errorCount: null,
        status: 'done',
        ticket: 'cc-10',
        warningCount: null,
      }),
    ).toBe('cc-10 done');
  });
});

const esc = '\u001b';

const coloredRecord: RequestRecord = {
  argv: ['cargo', 'check'],
  attachMode: null,
  attachedTo: null,
  background: false,
  createdAtMs: 1,
  cwd: '/ws',
  diagnostics: [`${esc}[1m${esc}[38;5;9merror[E0432]${esc}[0m: unresolved import\n`],
  error: null,
  errorCount: 1,
  estimateMs: null,
  execArgv: null,
  exitCode: 101,
  finishedAtMs: 2,
  holdStop: false,
  host: 'cursor',
  id: 1,
  intentJson: null,
  intentKey: null,
  laneKey: '["/ws","/ws/target"]',
  outputTail: `${esc}[0m\n ${esc}[1m${esc}[94m--> ${esc}[0msrc/lib.rs:3:5\n`,
  queuedAtMs: 1,
  runMs: 1,
  session: null,
  signal: null,
  startedAtMs: 1,
  status: 'failed',
  targetDir: '/ws/target',
  ticket: 'cc-1',
  waitMs: 0,
  warningCount: 0,
  workspaceRoot: '/ws',
};

describe('display projection', () => {
  it('strips stored ANSI for a no-color consumer, leaving other fields intact', () => {
    const projected = displayRequestRecord(coloredRecord, false);
    expect(projected.outputTail).toBe('\n --> src/lib.rs:3:5\n');
    expect(projected.diagnostics).toEqual(['error[E0432]: unresolved import\n']);
    expect(JSON.stringify(projected)).not.toContain('\\u001b');
    expect(projected.argv).toEqual(coloredRecord.argv);
    expect(projected.exitCode).toBe(101);
  });

  it('passes records through verbatim for a color-capable consumer', () => {
    expect(displayRequestRecord(coloredRecord, true)).toBe(coloredRecord);
    expect(displayRequestRecords([coloredRecord], true)).toEqual([coloredRecord]);
    const stripped = displayRequestRecords([coloredRecord], false);
    expect(stripped[0]?.outputTail).not.toContain(esc);
  });

  it('decides consumer color from TTY-ness and the color env conventions', () => {
    expect(consumerRendersColor({}, true)).toBe(true);
    expect(consumerRendersColor({}, false)).toBe(false);
    expect(consumerRendersColor({ NO_COLOR: '1' }, true)).toBe(false);
    expect(consumerRendersColor({ FORCE_COLOR: '1' }, false)).toBe(true);
    expect(consumerRendersColor({ TERM: 'dumb' }, true)).toBe(false);
  });
});

const isolatedConfig = () => {
  const root = mkdtempSync(join(tmpdir(), 'cc-query-'));
  return {
    config: resolveDaemonConfig({ CARGO_CONDUCTOR_STATE_DIR: join(root, 'state') }),
    root,
  };
};

describe('loadConductorSnapshot', () => {
  it('reports a stopped daemon and empty history when nothing has run', () =>
    withTempDir('cc-query-', async (root) => {
      const config = resolveDaemonConfig({ CARGO_CONDUCTOR_STATE_DIR: join(root, 'state') });
      const snapshot = await Effect.runPromise(loadConductorSnapshot({ config }));
      expect(snapshot.daemon).toBe('stopped');
      expect(snapshot.active).toEqual([]);
      expect(snapshot.recent).toEqual([]);
      expect(snapshot.lanes).toEqual([]);
      expect(snapshot.summary).toContain('daemon is not running');
      expect(snapshot.stateRoot).toBe(config.stateDir);
      expect(snapshot.socketPath).toBe(config.socketPath);
      expect(snapshot.report).toBeNull();
    }));

  it('reads the ledger when the daemon is down', async () => {
    const { config, root } = isolatedConfig();
    try {
      const db = openLedgerDatabase(config.databasePath);
      const ledger = createLedgerApi(db);
      Effect.runSync(
        ledger.createRequest({
          argv: ['cargo', 'check'],
          createdAtMs: 1_000,
          cwd: '/repo',
          host: 'cursor',
          intentJson: null,
          intentKey: 'k',
          laneKey: '/repo::/repo/target',
          session: 's',
          targetDir: '/repo/target',
          workspaceRoot: '/repo',
        }),
      );
      Effect.runSync(ledger.markFinished(1, { atMs: 2_000, exitCode: 0, status: 'done' }));
      db.close();

      const snapshot = await Effect.runPromise(loadConductorSnapshot({ config, recentLimit: 10 }));
      expect(snapshot.daemon).toBe('stopped');
      expect(snapshot.recent).toHaveLength(1);
      expect(snapshot.recent[0]?.ticket).toBe('cc-1');
      expect(snapshot.recent[0]?.status).toBe('done');
      expect(snapshot.summary).toContain('1 recorded request');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('uses the live daemon report when the broker is up', async () => {
    const { config, root } = isolatedConfig();
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => rmSync(root, { recursive: true, force: true })),
          );
          yield* Effect.forkScoped(runDaemon(config));
          yield* pingDaemon(config.socketPath, 500).pipe(
            Effect.retry(Schedule.spaced('50 millis').pipe(Schedule.upTo({ times: 100 }))),
          );
          yield* requestOverSocket({
            isTerminal: (message) => message.type === 'status-result',
            message: { id: 'snap', type: 'status' },
            socketPath: config.socketPath,
          });
          const snapshot = yield* loadConductorSnapshot({ config });
          expect(snapshot.daemon).toBe('running');
          expect(snapshot.pid).toBe(process.pid);
          expect(snapshot.report?.pid).toBe(process.pid);
          expect(snapshot.summary).toContain('daemon is running');
        }),
      ),
    );
  });
});
