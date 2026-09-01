import { existsSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';

import * as Effect from 'effect/Effect';
import type * as Scope from 'effect/Scope';

import { resolveDaemonConfig } from './daemon/config.js';
import type { DaemonConfigShape } from './daemon/config.js';
import { requestExpecting } from './daemon/control.js';
import { createLedgerApi, openLedgerDatabase, openLedgerDatabaseReadOnly } from './daemon/ledger.js';
import type {
  LaneStatus,
  RequestRecord,
  StatusMetrics,
  StatusReport,
  StatusResultMessage,
  SystemLoadReport,
} from './daemon/protocol.js';
import { stripAnsi } from './lib/ansi.js';
import { shortId } from './lib/id.js';
import { countWord } from './lib/text.js';

export interface ConductorSnapshot {
  readonly active: readonly RequestRecord[];
  readonly daemon: 'running' | 'stopped';
  readonly lanes: readonly LaneStatus[];
  readonly maxConcurrent: number | null;
  readonly metrics?: StatusMetrics;
  readonly system?: SystemLoadReport;
  readonly pid: number | null;
  readonly recent: readonly RequestRecord[];
  readonly report: StatusReport | null;
  readonly socketPath: string;
  readonly startedAtMs: number | null;
  readonly stateRoot: string;
  readonly summary: string;
}

export interface LoadSnapshotOptions {
  readonly config?: DaemonConfigShape;
  readonly recentLimit?: number;
}

const defaultRecentLimit = 50;

const requestWord = (count: number): string => (count === 1 ? 'request' : 'requests');

export const describeRequestRecord = (
  ticket: string,
  request:
    | Pick<RequestRecord, 'ticket' | 'status' | 'errorCount' | 'warningCount'>
    | null,
): string => {
  if (request === null) {
    return `${ticket} not found`;
  }
  const counts =
    request.errorCount === null || request.warningCount === null
      ? ''
      : ` (${countWord(request.errorCount, 'error')}, ${countWord(request.warningCount, 'warning')})`;
  return `${request.ticket} ${request.status}${counts}`;
};

/**
 * Projects one stored record onto a structured operation result. Ledger
 * records keep cargo output verbatim (color included), but every operation
 * result is JSON on the wire — the CLI prints `JSON.stringify(result)` and
 * MCP structured content is JSON-RPC — where an ESC byte can only ever
 * render as literal `\u001b[…` noise. That holds regardless of process
 * stdout: a TTY still sees the escaped JSON form, and an inherited
 * FORCE_COLOR/CLICOLOR_FORCE cannot make JSON paint color. So the
 * projection strips unconditionally; only the live `conductor exec` stream
 * (which never passes through here) keeps color for TTY consumers.
 */
export const displayRequestRecord = (record: RequestRecord): RequestRecord => ({
  ...record,
  outputTail: record.outputTail === null ? null : stripAnsi(record.outputTail),
  diagnostics: record.diagnostics === null ? null : record.diagnostics.map(stripAnsi),
});

export const displayRequestRecords = (
  records: readonly RequestRecord[],
): readonly RequestRecord[] => records.map(displayRequestRecord);

const stoppedSummary = (recentCount: number): string => {
  if (recentCount === 0) {
    return 'cargo-conductor daemon is not running';
  }
  return `cargo-conductor daemon is not running; ${recentCount} recorded ${requestWord(recentCount)}`;
};

const runningSummary = (report: StatusReport): string => {
  const queued = report.lanes.reduce((sum, lane) => sum + lane.queued, 0);
  const running = report.active.filter((record) => record.status === 'running').length;
  return `cargo-conductor daemon is running (pid ${report.pid}); ${queued} queued, ${running} running`;
};

/** Keep the internal raw report off the strict public status-result object spread. */
const withReport = (
  snapshot: Omit<ConductorSnapshot, 'report'>,
  report: StatusReport | null,
): ConductorSnapshot =>
  Object.defineProperty(snapshot, 'report', {
    enumerable: false,
    value: report,
  }) as ConductorSnapshot;

const fromReport = (report: StatusReport, config: DaemonConfigShape): ConductorSnapshot =>
  withReport(
    {
      active: report.active,
      daemon: 'running',
      ...(report.kache === undefined ? {} : { kache: report.kache }),
      ...(report.system === undefined ? {} : { system: report.system }),
      lanes: report.lanes,
      maxConcurrent: report.maxConcurrent,
      ...(report.metrics === undefined ? {} : { metrics: report.metrics }),
      pid: report.pid,
      recent: report.recent,
      socketPath: report.socketPath,
      startedAtMs: report.startedAtMs,
      stateRoot: config.stateDir,
      summary: runningSummary(report),
    },
    report,
  );

const emptyStopped = (config: DaemonConfigShape): ConductorSnapshot =>
  withReport(
    {
      active: [],
      daemon: 'stopped',
      lanes: [],
      maxConcurrent: null,
      pid: null,
      recent: [],
      socketPath: config.socketPath,
      startedAtMs: null,
      stateRoot: config.stateDir,
      summary: stoppedSummary(0),
    },
    null,
  );

/**
 * Scoped ledger handle for stopped-daemon reads: read-only when possible,
 * falling back to the writable opener for WAL recovery after an unclean stop
 * or a ledger predating a column migration. Always closed by the scope.
 */
const acquireSnapshotDb = (databasePath: string): Effect.Effect<DatabaseSync, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.try(() => openLedgerDatabaseReadOnly(databasePath)).pipe(
      Effect.catch(() => Effect.sync(() => openLedgerDatabase(databasePath))),
    ),
    (db) => Effect.sync(() => db.close()),
  );

const fromLedger = (
  config: DaemonConfigShape,
  recentLimit: number,
): Effect.Effect<ConductorSnapshot> => {
  if (!existsSync(config.databasePath)) {
    return Effect.succeed(emptyStopped(config));
  }
  return Effect.scoped(
    Effect.gen(function* () {
      const db = yield* acquireSnapshotDb(config.databasePath);
      const ledger = createLedgerApi(db);
      const recent = yield* ledger.recentRequests(recentLimit);
      const active = yield* ledger.activeRequests();
      return withReport(
        {
          active,
          daemon: 'stopped' as const,
          lanes: [],
          maxConcurrent: null,
          pid: null,
          recent,
          socketPath: config.socketPath,
          startedAtMs: null,
          stateRoot: config.stateDir,
          summary: stoppedSummary(recent.length),
        },
        null,
      );
    }),
  );
};

export const loadConductorSnapshot = (
  options: LoadSnapshotOptions = {},
): Effect.Effect<ConductorSnapshot> => {
  const config = options.config ?? resolveDaemonConfig();
  const recentLimit = options.recentLimit ?? defaultRecentLimit;
  return requestExpecting(
    {
      message: { id: shortId(), limit: recentLimit, type: 'status' },
      socketPath: config.socketPath,
      timeoutMs: 2_000,
    },
    (message): message is StatusResultMessage => message.type === 'status-result',
  ).pipe(
    Effect.flatMap((result) => {
      return result === undefined
        ? fromLedger(config, recentLimit)
        : Effect.succeed(fromReport(result.report, config));
    }),
    // Unreachable means stopped; a timeout or dropped connection means a
    // daemon that exists but did not answer — say so instead of "stopped".
    Effect.catchTags({
      ControlTimeout: () => unresponsiveSnapshot(config, recentLimit, 'did not answer within 2s'),
      ConnectionClosed: () => unresponsiveSnapshot(config, recentLimit, 'closed the connection mid-status'),
      DaemonUnreachable: () => fromLedger(config, recentLimit),
    }),
  );
};

const unresponsiveSnapshot = (
  config: DaemonConfigShape,
  recentLimit: number,
  what: string,
): Effect.Effect<ConductorSnapshot> =>
  fromLedger(config, recentLimit).pipe(
    Effect.map((snapshot) =>
      withReport(
        {
          ...snapshot,
          summary: `cargo-conductor daemon ${what}; showing ledger data (${snapshot.recent.length} recorded)`,
        },
        snapshot.report,
      ),
    ),
  );
