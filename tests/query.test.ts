import { mkdirSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { join } from 'node:path';

import { describe, expect, it } from 'effect-rstest';
import * as Effect from 'effect/Effect';
import * as Schedule from 'effect/Schedule';

import { resolveDaemonConfig } from '../src/daemon/config.js';
import { pingDaemon, requestOverSocket } from '../src/daemon/control.js';
import { runDaemon } from '../src/daemon/main.js';
import type { RequestRecord } from '../src/daemon/protocol.js';
import { loadLastResult, loadStatusResult } from '../src/lib/inspect.js';
import { filterStatusRows, statusSummary } from '../src/lib/status-filter.js';
import { scopedEnv, scopedLedger, scopedTempDir } from './harness.js';
import {
  describeRequestRecord,
  displayRequestRecord,
  displayRequestRecords,
  loadHaulerSnapshot,
} from '../src/query.js';

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

  it('tells a poller how to release a stalled running ticket (#46)', () => {
    expect(
      describeRequestRecord('cc-3062', {
        attachedTo: null,
        errorCount: null,
        stall: { cpuMs: 2_700, idleMs: 42 * 60_000 + 10_000, since: 1 },
        status: 'running',
        ticket: 'cc-3062',
        warningCount: null,
      }),
    ).toBe('cc-3062 running — ticket looks stalled (no CPU for 42m) — hauler kill cc-3062');
    expect(
      describeRequestRecord('cc-3063', {
        attachedTo: 'cc-3062',
        errorCount: null,
        stall: { cpuMs: 2_700, idleMs: 42 * 60_000, since: 1 },
        status: 'running',
        ticket: 'cc-3063',
        warningCount: null,
      }),
    ).toBe('cc-3063 running — ticket looks stalled (no CPU for 42m) — hauler kill cc-3062');
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
  outputPath: null,
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

describe('status scoping', () => {
  const running: RequestRecord = {
    ...coloredRecord,
    cwd: '/ws/other',
    errorCount: null,
    exitCode: null,
    finishedAtMs: null,
    laneKey: 'lane-other',
    outputTail: null,
    session: 'session-1',
    status: 'running',
    ticket: 'cc-2',
  };

  it('filters status rows without requiring CLI jq projections', () => {
    expect(filterStatusRows([coloredRecord, running], { session: 'session-1' })).toEqual([running]);
    expect(
      filterStatusRows([coloredRecord, running], {
        commandContains: 'check',
        statuses: ['failed'],
        tickets: ['cc-1'],
      }),
    ).toEqual([coloredRecord]);
  });

  it('renders active ticket one-liners in MCP text content', () => {
    expect(statusSummary('running', [running], [])).toContain(
      'cc-2 running cargo check (session-1)',
    );
  });

  it('shows the program by basename when the PATH shim passed the real cargo path', () => {
    expect(
      statusSummary('running', [{ ...running, argv: ['/home/me/.cargo/bin/cargo', 'check'] }], []),
    ).toContain('cc-2 running cargo check (session-1)');
  });

  it('distinguishes an unresponsive daemon from a stopped one in the header', () => {
    expect(statusSummary('unresponsive', [running], [])).toContain(
      'daemon is up but did not answer in time',
    );
    expect(statusSummary('stopped', [], [])).toContain('daemon is not running');
  });

  it('bounds active commands in MCP text while preserving ticket, status, and location', () => {
    const longCommand = ['cargo', 'nextest', 'run', '-E', 'x'.repeat(220)].join(' ');
    const summary = statusSummary(
      'running',
      [{ ...running, argv: ['cargo', 'nextest', 'run', '-E', 'x'.repeat(220)] }],
      [],
    );
    const activeLine = summary.split('\n')[1];
    const truncatedCommand = `${longCommand.slice(0, 159)}…`;
    expect(truncatedCommand).toHaveLength(160);
    expect(activeLine).toBe(`cc-2 running ${truncatedCommand} (session-1)`);
  });
});

describe('display projection', () => {
  it('strips stored ANSI unconditionally, leaving other fields intact', () => {
    const projected = displayRequestRecord(coloredRecord);
    expect(projected.outputTail).toBe('\n --> src/lib.rs:3:5\n');
    expect(projected.diagnostics).toEqual(['error[E0432]: unresolved import\n']);
    expect(JSON.stringify(projected)).not.toContain('\\u001b');
    expect(projected.argv).toEqual(coloredRecord.argv);
    expect(projected.exitCode).toBe(101);
  });

  it('never leaves an ESC byte in a projected record list', () => {
    const stripped = displayRequestRecords([coloredRecord]);
    expect(stripped[0]?.outputTail).not.toContain(esc);
    expect(JSON.stringify(stripped)).not.toContain('\\u001b');
  });
});

const isolatedConfig = scopedTempDir('cargo-hauler-query-').pipe(
  Effect.map((root) => resolveDaemonConfig({ CARGO_HAULER_STATE_DIR: join(root, 'state') })),
);

describe('loadHaulerSnapshot', () => {
  it.live('reports a stopped daemon and empty history when nothing has run', () =>
    Effect.gen(function* () {
      const config = yield* isolatedConfig;
      const snapshot = yield* loadHaulerSnapshot({ config });
      expect(snapshot.daemon).toBe('stopped');
      expect(snapshot.active).toEqual([]);
      expect(snapshot.recent).toEqual([]);
      expect(snapshot.lanes).toEqual([]);
      expect(snapshot.summary).toContain('daemon is not running');
      expect(snapshot.stateRoot).toBe(config.stateDir);
      expect(snapshot.socketPath).toBe(config.socketPath);
      expect(snapshot.report).toBeNull();
    }));

  it.live(
    'reports an unresponsive daemon, not a stopped one, when the socket accepts but never answers',
    () =>
      Effect.gen(function* () {
        const config = yield* isolatedConfig;
        mkdirSync(config.stateDir, { recursive: true });
        const accepted = new Set<Socket>();
        yield* Effect.acquireRelease(
          Effect.callback<Server>((resume) => {
            const server = createServer((socket) => {
              accepted.add(socket);
            });
            server.listen(config.socketPath, () => resume(Effect.succeed(server)));
          }),
          (server) =>
            Effect.callback<void>((resume) => {
              for (const socket of accepted) {
                socket.destroy();
              }
              server.close(() => resume(Effect.void));
            }),
        );
        const snapshot = yield* loadHaulerSnapshot({ config });
        expect(snapshot.daemon).toBe('unresponsive');
        expect(snapshot.summary).toContain('did not answer within');
        expect(snapshot.summary).not.toContain('not running');
      }),
    15_000,
  );

  it.live('reads the ledger when the daemon is down', () =>
    Effect.gen(function* () {
      const config = yield* isolatedConfig;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const ledger = yield* scopedLedger(config);
          yield* ledger.createRequest({
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
          });
          yield* ledger.markFinished(1, { atMs: 2_000, exitCode: 0, status: 'done' });
        }),
      );

      const snapshot = yield* loadHaulerSnapshot({ config, recentLimit: 10 });
      expect(snapshot.daemon).toBe('stopped');
      expect(snapshot.recent).toHaveLength(1);
      expect(snapshot.recent[0]?.ticket).toBe('cc-1');
      expect(snapshot.recent[0]?.status).toBe('done');
      expect(snapshot.summary).toContain('1 recorded request');
    }));

  it.live('keeps ESC out of structured operation results even under inherited FORCE_COLOR', () =>
    Effect.gen(function* () {
      // MCP servers and the CLI both serialize operation results to JSON,
      // where an ESC byte is literal `\u001b[…` noise. An environment that
      // forces color on (FORCE_COLOR/CLICOLOR_FORCE) must not reintroduce it.
      const config = yield* isolatedConfig;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const ledger = yield* scopedLedger(config);
          yield* ledger.createRequest({
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
          });
          yield* ledger.markFinished(1, {
            atMs: 2_000,
            exitCode: 101,
            outputTail: `${esc}[1m${esc}[31merror${esc}[0m: it broke\n`,
            status: 'failed',
          });
        }),
      );

      yield* scopedEnv({
        CARGO_HAULER_STATE_DIR: config.stateDir,
        CLICOLOR_FORCE: '1',
        FORCE_COLOR: '1',
      });
      const last = yield* Effect.promise((signal) => loadLastResult({ signal }));
      expect(last.request?.outputTail).toBe('error: it broke\n');
      expect(JSON.stringify(last)).not.toContain('\\u001b');
      const status = yield* Effect.promise((signal) => loadStatusResult({}, { signal }));
      expect(JSON.stringify(status)).not.toContain('\\u001b');
    }));

  it.live('uses the live daemon report when the broker is up', () =>
    Effect.gen(function* () {
      const config = yield* isolatedConfig;
      yield* Effect.forkScoped(runDaemon(config));
      yield* pingDaemon(config.socketPath, 500).pipe(
        Effect.retry(Schedule.spaced('50 millis').pipe(Schedule.upTo({ times: 100 }))),
      );
      yield* requestOverSocket({
        isTerminal: (message) => message.type === 'status-result',
        message: { id: 'snap', type: 'status' },
        socketPath: config.socketPath,
      });
      const snapshot = yield* loadHaulerSnapshot({ config });
      expect(snapshot.daemon).toBe('running');
      expect(snapshot.pid).toBe(process.pid);
      expect(snapshot.report?.pid).toBe(process.pid);
      expect(snapshot.summary).toContain('daemon is running');
    }));
});
