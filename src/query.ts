import { existsSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';

import * as Effect from 'effect/Effect';
import type * as Scope from 'effect/Scope';

import { resolveDaemonConfig } from './daemon/config.js';
import type { DaemonConfigShape } from './daemon/config.js';
import { requestExpecting } from './daemon/control.js';
import { createLedgerApi, openLedgerDatabase, openLedgerDatabaseReadOnly } from './daemon/ledger.js';
import { isOrphanedByRestart, orphanedByRestartError } from './daemon/protocol.js';
import type {
  AttachmentSavingsReport,
  KacheStatusReport,
  LaneStatus,
  RequestRecord,
  StatusMetrics,
  StatusReport,
  StatusResultMessage,
  SystemLoadReport,
} from './daemon/protocol.js';
import { stripAnsi } from './lib/ansi.js';
import { shortId } from './lib/id.js';
import { statusReportSchema, type DaemonStatus } from './lib/protocol-schemas.js';
import { countWord } from './lib/text.js';
import {
  learnDaemonVersion,
  validateDaemonReply,
  versionSkewLine,
  type DaemonVersionSkewError,
} from './lib/version-skew.js';

export interface HaulerSnapshot {
  readonly active: readonly RequestRecord[];
  readonly daemon: DaemonStatus;
  /** The running daemon's release version, when it stated one (report or pong); absent when stopped. */
  readonly daemonVersion?: string;
  readonly kache?: KacheStatusReport | null;
  readonly lanes: readonly LaneStatus[];
  readonly maxConcurrent: number | null;
  readonly metrics?: StatusMetrics;
  readonly savings?: AttachmentSavingsReport;
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

/**
 * Status is a read on a daemon that may be fanning out several builds' output
 * on a saturated machine; the exec client tolerates a minute of slow accepts,
 * so a status read gets more than the 2s socket-open budget too.
 */
const statusTimeoutMs = 5_000;

/**
 * `hauler result` / `hauler_result` guidance for a running ticket the daemon
 * has flagged stalled (#46): name the idle window and the one command that
 * releases the lane. Riders share the leader's process, so the kill names
 * the leader.
 */
export const stalledGuidance = (
  request: Pick<RequestRecord, 'ticket' | 'status'> & Partial<Pick<RequestRecord, 'attachedTo' | 'stall'>>,
): string | null =>
  request.status === 'running' && request.stall !== undefined
    ? `ticket looks stalled (no CPU for ${Math.floor(request.stall.idleMs / 60_000)}m) — hauler kill ${request.attachedTo ?? request.ticket}`
    : null;

/**
 * `hauler result` / `hauler_result` explanation for a ticket the daemon
 * restart ended (#75): it was not killed by anyone and did not fail on its
 * own, so a plain `killed` would send the reader looking for a cause.
 */
export const orphanedGuidance = (
  request: Pick<RequestRecord, 'status'> & Partial<Pick<RequestRecord, 'error'>>,
): string | null =>
  request.error !== undefined && isOrphanedByRestart({ error: request.error, status: request.status })
    ? `${orphanedByRestartError}: the daemon stopped while it was in flight and does not hand runs over; resubmit if the work is still needed`
    : null;

export const describeRequestRecord = (
  ticket: string,
  request:
    | (Pick<RequestRecord, 'ticket' | 'status' | 'errorCount' | 'warningCount'> &
        Partial<Pick<RequestRecord, 'attachedTo' | 'error' | 'stall'>>)
    | null,
): string => {
  if (request === null) {
    return `${ticket} not found`;
  }
  const counts =
    request.errorCount === null || request.warningCount === null
      ? ''
      : ` (${countWord(request.errorCount, 'error')}, ${countWord(request.warningCount, 'warning')})`;
  const note = stalledGuidance(request) ?? orphanedGuidance(request);
  return `${request.ticket} ${request.status}${counts}${note === null ? '' : ` — ${note}`}`;
};

/**
 * Projects one stored record onto a structured operation result. Ledger
 * records keep cargo output verbatim (color included), but every operation
 * result is JSON on the wire — the CLI prints `JSON.stringify(result)` and
 * MCP structured content is JSON-RPC — where an ESC byte can only ever
 * render as literal `\u001b[…` noise. That holds regardless of process
 * stdout: a TTY still sees the escaped JSON form, and an inherited
 * FORCE_COLOR/CLICOLOR_FORCE cannot make JSON paint color. So the
 * projection strips unconditionally; only the live `hauler exec` stream
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
    return 'cargo-hauler daemon is not running';
  }
  return `cargo-hauler daemon is not running; ${countWord(recentCount, 'recorded request')}`;
};

const runningSummary = (report: StatusReport, daemonVersion: string | undefined): string => {
  const queued = report.lanes.reduce((sum, lane) => sum + lane.queued, 0);
  const running = report.active.filter((record) => record.status === 'running').length;
  const skew = versionSkewLine(daemonVersion);
  return `cargo-hauler daemon is running (pid ${report.pid}); ${queued} queued, ${running} running${skew === null ? '' : `; ${skew}`}`;
};

/** Keep the internal raw report off the strict public status-result object spread. */
const withReport = (
  snapshot: Omit<HaulerSnapshot, 'report'>,
  report: StatusReport | null,
): HaulerSnapshot =>
  Object.defineProperty(snapshot, 'report', {
    enumerable: false,
    value: report,
  }) as HaulerSnapshot;

const fromReport = (
  report: StatusReport,
  config: DaemonConfigShape,
  daemonVersion: string | undefined,
): HaulerSnapshot =>
  withReport(
    {
      active: report.active,
      daemon: 'running',
      ...(daemonVersion === undefined ? {} : { daemonVersion }),
      ...(report.kache === undefined ? {} : { kache: report.kache }),
      ...(report.system === undefined ? {} : { system: report.system }),
      lanes: report.lanes,
      maxConcurrent: report.maxConcurrent,
      ...(report.metrics === undefined ? {} : { metrics: report.metrics }),
      ...(report.savings === undefined ? {} : { savings: report.savings }),
      pid: report.pid,
      recent: report.recent,
      socketPath: report.socketPath,
      startedAtMs: report.startedAtMs,
      stateRoot: config.stateDir,
      summary: runningSummary(report, daemonVersion),
    },
    report,
  );

/**
 * A live daemon's report, read with the lenient client schema so a daemon
 * left running across an upgrade still answers (#75). A report that does not
 * fit fails as version skew; the daemon's version rides the report from
 * 0.4.5 on and is fetched with one ping from older daemons.
 */
const fromLiveReport = (
  raw: unknown,
  config: DaemonConfigShape,
): Effect.Effect<HaulerSnapshot, DaemonVersionSkewError> =>
  Effect.gen(function* () {
    const report = yield* validateDaemonReply(statusReportSchema, raw, config.socketPath);
    const daemonVersion = yield* learnDaemonVersion(report, config.socketPath);
    return fromReport(report, config, daemonVersion);
  });

const emptyStopped = (config: DaemonConfigShape): HaulerSnapshot =>
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
): Effect.Effect<HaulerSnapshot> => {
  if (!existsSync(config.databasePath)) {
    return Effect.succeed(emptyStopped(config));
  }
  return Effect.scoped(
    Effect.gen(function* () {
      const db = yield* acquireSnapshotDb(config.databasePath);
      const ledger = createLedgerApi(db);
      const recent = yield* ledger.recentRequests(recentLimit);
      const active = yield* ledger.activeRequests();
      const savings = yield* ledger.attachmentSavings();
      return withReport(
        {
          active,
          daemon: 'stopped' as const,
          lanes: [],
          maxConcurrent: null,
          pid: null,
          recent,
          savings,
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

/**
 * Fails only with `DaemonVersionSkew`: a daemon that answered with a report
 * this build cannot read. Every other way of not reaching the daemon is a
 * snapshot that says so (`stopped`, `unresponsive`).
 */
export const loadHaulerSnapshot = (
  options: LoadSnapshotOptions = {},
): Effect.Effect<HaulerSnapshot, DaemonVersionSkewError> => {
  const config = options.config ?? resolveDaemonConfig();
  const recentLimit = options.recentLimit ?? defaultRecentLimit;
  return requestExpecting(
    {
      message: { id: shortId(), limit: recentLimit, type: 'status' },
      socketPath: config.socketPath,
      timeoutMs: statusTimeoutMs,
    },
    (message): message is StatusResultMessage => message.type === 'status-result',
  ).pipe(
    Effect.flatMap((result) =>
      result === undefined ? fromLedger(config, recentLimit) : fromLiveReport(result.report, config),
    ),
    // Unreachable means stopped; a timeout or dropped connection means a
    // daemon that exists but did not answer — say so instead of "stopped".
    Effect.catchTags({
      ControlTimeout: () =>
        unresponsiveSnapshot(config, recentLimit, `did not answer within ${statusTimeoutMs / 1000}s`),
      ConnectionClosed: () => unresponsiveSnapshot(config, recentLimit, 'closed the connection mid-status'),
      DaemonUnreachable: () => fromLedger(config, recentLimit),
    }),
  );
};

const unresponsiveSnapshot = (
  config: DaemonConfigShape,
  recentLimit: number,
  what: string,
): Effect.Effect<HaulerSnapshot> =>
  fromLedger(config, recentLimit).pipe(
    Effect.map((snapshot) =>
      withReport(
        {
          ...snapshot,
          daemon: 'unresponsive',
          summary: `cargo-hauler daemon ${what}; showing ledger data (${snapshot.recent.length} recorded)`,
        },
        snapshot.report,
      ),
    ),
  );
