import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';

import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';

import { isRecord } from '../lib/guards.js';
import '../lib/quiet-sqlite-warning.js';

import { DaemonConfig } from './config.js';
import { defaultCargoProfile } from './intent-normalizer.js';
import { formatTicket, parseTicket } from './protocol.js';
import type {
  AttachmentSavingsModeReport,
  AttachmentSavingsReport,
  AttachmentSavingsTotalsReport,
  AttachMode,
  FinishedStatus,
  PassthroughSpoolRecord,
  RequestRecord,
  RequestStatus,
  SavedComputeSource,
  SessionCompletedRecord,
  SessionPendingRecord,
  TransitionRecord,
} from './protocol.js';
import { passthroughSpoolFileName } from './protocol.js';
import { calculateServedSavings } from './savings.js';

export interface CreateRequestInput {
  readonly createdAtMs: number;
  readonly session: string | null;
  readonly host: string | null;
  readonly cwd: string;
  readonly workspaceRoot: string;
  readonly targetDir: string;
  readonly laneKey: string;
  readonly argv: readonly string[];
  readonly intentKey: string | null;
  readonly intentJson: string | null;
  readonly background?: boolean;
  readonly holdStop?: boolean;
  readonly estimateMs?: number | null;
}

export interface FinishRequestInput {
  readonly status: FinishedStatus;
  readonly atMs: number;
  readonly exitCode?: number | null;
  readonly signal?: string | null;
  readonly outputTail?: string | null;
  readonly error?: string | null;
  readonly errorCount?: number | null;
  readonly warningCount?: number | null;
  readonly diagnostics?: readonly string[] | null;
  readonly savedComputeMs?: number | null;
  readonly savedComputeSource?: SavedComputeSource | null;
  readonly savedLatencyMs?: number | null;
}

export interface RecordAttemptInput {
  readonly atMs: number;
  readonly session: string | null;
  readonly host: string | null;
  readonly cwd: string;
  readonly argv: readonly string[];
  readonly status: 'denied' | 'passthrough';
  readonly exitCode?: number | null;
  readonly error?: string | null;
  readonly sourceAttemptId?: string;
}

export interface AttachRequestInput {
  readonly atMs: number;
  readonly leaderTicket: string;
  readonly mode: AttachMode;
}

export interface MetricsWindowBySubcommand {
  readonly subcommand: string;
  readonly profile?: string;
  readonly count: number;
  readonly p50Ms: number | null;
  readonly maxMs: number | null;
}

export interface MetricsWindowReport {
  readonly count: number;
  readonly done: number;
  readonly failed: number;
  readonly killed: number;
  readonly runP50Ms: number | null;
  readonly runP95Ms: number | null;
  readonly runMeanMs: number | null;
  readonly waitP50Ms: number | null;
  readonly waitP95Ms: number | null;
  readonly bySubcommand: readonly MetricsWindowBySubcommand[];
}

export interface MetricsWindowsReport {
  readonly hour: MetricsWindowReport;
  readonly day: MetricsWindowReport;
  readonly all: MetricsWindowReport;
}

export interface LedgerApi {
  readonly createRequest: (
    input: CreateRequestInput,
  ) => Effect.Effect<{ readonly id: number; readonly ticket: string }>;
  readonly markQueued: (id: number, atMs: number) => Effect.Effect<void>;
  /** `execArgv` records the invocation actually spawned (demux flag, batch -p folds). */
  readonly markRunning: (
    id: number,
    atMs: number,
    execArgv?: readonly string[],
  ) => Effect.Effect<void>;
  readonly markAttached: (id: number, input: AttachRequestInput) => Effect.Effect<void>;
  readonly markRequeued: (id: number, atMs: number) => Effect.Effect<void>;
  readonly markFinished: (id: number, input: FinishRequestInput) => Effect.Effect<void>;
  /**
   * The submitting client stopped streaming this ticket (auto-background
   * conversion), so its exit will reach the agent only through
   * `sessionCompleted`. Leaves `hold_stop` untouched. False when no such row.
   */
  readonly markDetached: (id: number) => Effect.Effect<boolean>;
  readonly recordAttempt: (
    input: RecordAttemptInput,
  ) => Effect.Effect<{ readonly id: number; readonly ticket: string }>;
  readonly ingestPassthroughSpool: (stateDir: string) => Effect.Effect<number>;
  readonly getRequest: (id: number) => Effect.Effect<RequestRecord | null>;
  readonly getRequestByTicket: (ticket: string) => Effect.Effect<RequestRecord | null>;
  /** Newest-first run durations of completed non-attached runs of one intent. */
  readonly recentDurations: (
    intentKey: string,
    limit: number,
  ) => Effect.Effect<readonly number[]>;
  readonly sessionPending: (
    session: string,
  ) => Effect.Effect<readonly SessionPendingRecord[]>;
  readonly sessionCompleted: (
    session: string,
    sinceMs: number,
  ) => Effect.Effect<readonly SessionCompletedRecord[]>;
  readonly recentRequests: (limit: number) => Effect.Effect<readonly RequestRecord[]>;
  readonly activeRequests: () => Effect.Effect<readonly RequestRecord[]>;
  /** Dashboard status rows deliberately omit captured output blobs. */
  readonly recentStatusRequests: (limit: number) => Effect.Effect<readonly RequestRecord[]>;
  readonly activeStatusRequests: () => Effect.Effect<readonly RequestRecord[]>;
  readonly transitionsFor: (id: number) => Effect.Effect<readonly TransitionRecord[]>;
  readonly reapOrphans: (atMs: number, error: string) => Effect.Effect<number>;
  readonly attachmentSavings: () => Effect.Effect<AttachmentSavingsReport>;
  readonly metricsWindow: (sinceMs: number | null) => Effect.Effect<MetricsWindowReport>;
  /** One cached scan supplies all dashboard windows. */
  readonly metricsWindows: (nowMs: number) => Effect.Effect<MetricsWindowsReport>;
}

export class Ledger extends Context.Service<Ledger, LedgerApi>()('cargo-hauler/Ledger') {}

const schemaStatements = `
CREATE TABLE IF NOT EXISTS requests (
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
  status TEXT NOT NULL CHECK (
    status IN ('requested', 'queued', 'running', 'done', 'failed', 'killed', 'denied', 'passthrough')
  ),
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
CREATE TABLE IF NOT EXISTS transitions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id INTEGER NOT NULL,
  at_ms INTEGER NOT NULL,
  from_status TEXT,
  to_status TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS requests_status_idx ON requests (status);
CREATE INDEX IF NOT EXISTS requests_created_at_ms_idx ON requests (created_at_ms);
CREATE INDEX IF NOT EXISTS requests_session_finished_idx ON requests (session, finished_at_ms);
CREATE INDEX IF NOT EXISTS requests_intent_status_id_idx ON requests (intent_key, status, id);
CREATE INDEX IF NOT EXISTS transitions_request_id_idx ON transitions (request_id);
`;

const requestColumns = `id, created_at_ms, session, host, cwd, workspace_root, target_dir, lane_key,
  argv_json, intent_key, intent_json, status, queued_at_ms, started_at_ms, finished_at_ms, wait_ms,
  run_ms, exit_code, signal, output_tail, error, attached_to, attach_mode, background, hold_stop,
  estimate_ms, exec_argv_json, error_count, warning_count, diagnostics_json, saved_compute_ms,
  saved_compute_source, saved_latency_ms`;

const statusRequestColumns = `id, created_at_ms, session, host, cwd, workspace_root, target_dir, lane_key,
  argv_json, intent_key, intent_json, status, queued_at_ms, started_at_ms, finished_at_ms, wait_ms,
  run_ms, exit_code, signal, NULL AS output_tail, error, attached_to, attach_mode, background, hold_stop,
  estimate_ms, exec_argv_json, error_count, warning_count, diagnostics_json, saved_compute_ms,
  saved_compute_source, saved_latency_ms`;

const columnMigrations: readonly (readonly [column: string, ddl: string])[] = [
  ['attached_to', 'ALTER TABLE requests ADD COLUMN attached_to TEXT'],
  ['attach_mode', 'ALTER TABLE requests ADD COLUMN attach_mode TEXT'],
  ['background', 'ALTER TABLE requests ADD COLUMN background INTEGER NOT NULL DEFAULT 0'],
  ['hold_stop', 'ALTER TABLE requests ADD COLUMN hold_stop INTEGER NOT NULL DEFAULT 0'],
  ['estimate_ms', 'ALTER TABLE requests ADD COLUMN estimate_ms INTEGER'],
  ['exec_argv_json', 'ALTER TABLE requests ADD COLUMN exec_argv_json TEXT'],
  ['error_count', 'ALTER TABLE requests ADD COLUMN error_count INTEGER'],
  ['warning_count', 'ALTER TABLE requests ADD COLUMN warning_count INTEGER'],
  ['diagnostics_json', 'ALTER TABLE requests ADD COLUMN diagnostics_json TEXT'],
  ['saved_compute_ms', 'ALTER TABLE requests ADD COLUMN saved_compute_ms INTEGER'],
  ['saved_compute_source', 'ALTER TABLE requests ADD COLUMN saved_compute_source TEXT'],
  ['saved_latency_ms', 'ALTER TABLE requests ADD COLUMN saved_latency_ms INTEGER'],
  ['source_attempt_id', 'ALTER TABLE requests ADD COLUMN source_attempt_id TEXT'],
];

const activeStatusFilter = "status IN ('requested', 'queued', 'running')";

/**
 * Terminal rows are never reopened. Attach and running writes can trail a
 * settlement (a follower registered as its leader exits); without this guard
 * the late write would flip a `done` row back to `queued`/`running` and the
 * ticket would never read as terminal again.
 */
const notTerminalFilter = "status NOT IN ('done', 'failed', 'killed', 'denied', 'passthrough')";

/**
 * Dashboard windows scan only recent leader-settled rows. Keeping this bounded
 * prevents one status poll from full-scanning a very large ledger.
 */
const metricsWindowScanLimit = 20_000;

type Row = Record<string, unknown>;

const toNumber = (value: unknown): number => Number(value);

const toNullableNumber = (value: unknown): number | null =>
  value === null || value === undefined ? null : Number(value);

const toText = (value: unknown): string => String(value);

const toNullableText = (value: unknown): string | null =>
  value === null || value === undefined ? null : String(value);

const asSavedComputeSource = (value: unknown): SavedComputeSource | null => {
  if (value === 'exact' || value === 'estimate') {
    return value;
  }
  return null;
};

const toNullableStringArray = (value: unknown): readonly string[] | null => {
  if (value === null || value === undefined) {
    return null;
  }
  const parsed = JSON.parse(String(value)) as unknown;
  return Array.isArray(parsed)
    ? parsed.filter((entry): entry is string => typeof entry === 'string')
    : null;
};

const toRequestRecord = (row: Row): RequestRecord => {
  const id = toNumber(row.id);
  return {
    id,
    ticket: formatTicket(id),
    createdAtMs: toNumber(row.created_at_ms),
    session: toNullableText(row.session),
    host: toNullableText(row.host),
    cwd: toText(row.cwd),
    workspaceRoot: toText(row.workspace_root),
    targetDir: toText(row.target_dir),
    laneKey: toText(row.lane_key),
    argv: JSON.parse(toText(row.argv_json)) as readonly string[],
    intentKey: toNullableText(row.intent_key),
    intentJson: toNullableText(row.intent_json),
    status: toText(row.status) as RequestStatus,
    queuedAtMs: toNullableNumber(row.queued_at_ms),
    startedAtMs: toNullableNumber(row.started_at_ms),
    finishedAtMs: toNullableNumber(row.finished_at_ms),
    waitMs: toNullableNumber(row.wait_ms),
    runMs: toNullableNumber(row.run_ms),
    exitCode: toNullableNumber(row.exit_code),
    signal: toNullableText(row.signal),
    outputTail: toNullableText(row.output_tail),
    error: toNullableText(row.error),
    errorCount: toNullableNumber(row.error_count),
    warningCount: toNullableNumber(row.warning_count),
    diagnostics: toNullableStringArray(row.diagnostics_json),
    attachedTo: toNullableText(row.attached_to),
    attachMode: toNullableText(row.attach_mode) as AttachMode | null,
    savedComputeMs: toNullableNumber(row.saved_compute_ms),
    savedComputeSource: asSavedComputeSource(row.saved_compute_source),
    savedLatencyMs: toNullableNumber(row.saved_latency_ms),
    background: toNumber(row.background ?? 0) !== 0,
    holdStop: toNumber(row.hold_stop ?? 0) !== 0,
    estimateMs: toNullableNumber(row.estimate_ms),
    execArgv:
      row.exec_argv_json == null
        ? null
        : (JSON.parse(toText(row.exec_argv_json)) as readonly string[]),
  };
};

const toTransitionRecord = (row: Row): TransitionRecord => ({
  requestId: toNumber(row.request_id),
  atMs: toNumber(row.at_ms),
  fromStatus: toNullableText(row.from_status) as RequestStatus | null,
  toStatus: toText(row.to_status) as RequestStatus,
});

const percentileFromSorted = (
  sorted: readonly number[],
  percentile: number,
): number | null => {
  if (sorted.length === 0) {
    return null;
  }
  return sorted[Math.floor((sorted.length - 1) * percentile)] ?? null;
};

const mean = (values: readonly number[]): number | null =>
  values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;

const recordTransition = (
  statement: StatementSync,
  requestId: number,
  atMs: number,
  fromStatus: RequestStatus | null,
  toStatus: RequestStatus,
): void => {
  statement.run(requestId, atMs, fromStatus, toStatus);
};

const readStatus = (statement: StatementSync, id: number): RequestStatus | null => {
  const row = statement.get(id);
  return row === undefined ? null : (toText(row.status) as RequestStatus);
};

const selectRequestById = (statement: StatementSync, id: number): RequestRecord | null => {
  const row = statement.get(id);
  return row === undefined ? null : toRequestRecord(row);
};

/**
 * Older ledgers predate settlement-time savings columns. Their served rider
 * rows still contain the same counterfactual inputs, so backfill once instead
 * of showing zero forever after an upgrade.
 */
const backfillAttachmentSavings = (db: DatabaseSync): void => {
  const rows = db
    .prepare(
      `SELECT f.id,
              f.attach_mode,
              f.estimate_ms,
              f.created_at_ms,
              f.finished_at_ms,
              l.run_ms AS leader_run_ms
       FROM requests f
       LEFT JOIN requests l ON ('cc-' || l.id) = f.attached_to
       WHERE f.attached_to IS NOT NULL
         AND f.saved_compute_ms IS NULL
         AND f.status IN ('done', 'failed')
         AND f.finished_at_ms IS NOT NULL
         AND f.estimate_ms IS NOT NULL
         AND f.attach_mode IN ('identity', 'coverage', 'batch')`,
    )
    .all() as readonly Row[];
  if (rows.length === 0) {
    return;
  }
  const update = db.prepare(
    `UPDATE requests
     SET saved_compute_ms = ?, saved_compute_source = ?, saved_latency_ms = ?
     WHERE id = ? AND saved_compute_ms IS NULL`,
  );
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const row of rows) {
      const savings = calculateServedSavings(
        toText(row.attach_mode) as AttachMode,
        toNumber(row.estimate_ms),
        toNumber(row.created_at_ms),
        toNumber(row.finished_at_ms),
        toNullableNumber(row.leader_run_ms),
      );
      update.run(
        savings.savedComputeMs,
        savings.savedComputeSource,
        savings.savedLatencyMs,
        toNumber(row.id),
      );
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
};

/**
 * Read-only connection for inspecting the ledger without the daemon. Never
 * creates directories, switches journal modes, or runs migrations. WAL
 * recovery after an unclean daemon stop (and pending column migrations)
 * need a writable connection, so callers fall back to openLedgerDatabase.
 */
export const openLedgerDatabaseReadOnly = (databasePath: string): DatabaseSync => {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  db.exec('PRAGMA busy_timeout = 5000;');
  return db;
};

export const openLedgerDatabase = (databasePath: string): DatabaseSync => {
  mkdirSync(dirname(databasePath), { recursive: true });
  const db = new DatabaseSync(databasePath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec(schemaStatements);
  const existingColumns = new Set(
    db
      .prepare('PRAGMA table_info(requests)')
      .all()
      .map((row) => String((row as Row).name)),
  );
  for (const [column, ddl] of columnMigrations) {
    if (!existingColumns.has(column)) {
      db.exec(ddl);
    }
  }
  backfillAttachmentSavings(db);
  db.exec(
    'CREATE UNIQUE INDEX IF NOT EXISTS requests_source_attempt_id_idx ON requests (source_attempt_id) WHERE source_attempt_id IS NOT NULL',
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS requests_attachment_savings_idx
     ON requests (attach_mode, saved_compute_source, saved_latency_ms)
     WHERE attached_to IS NOT NULL
       AND saved_compute_ms IS NOT NULL
       AND saved_latency_ms IS NOT NULL`,
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS requests_metrics_window_idx
     ON requests (finished_at_ms DESC, id DESC)
     WHERE attached_to IS NULL
       AND run_ms IS NOT NULL`,
  );
  return db;
};

const parsePassthroughSpoolRecord = (line: string): PassthroughSpoolRecord | null => {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    value.kind !== 'passthrough' ||
    typeof value.id !== 'string' ||
    typeof value.atMs !== 'number' ||
    !Array.isArray(value.argv) ||
    !value.argv.every((entry) => typeof entry === 'string') ||
    typeof value.cwd !== 'string' ||
    (value.session !== null && typeof value.session !== 'string') ||
    (value.host !== null && typeof value.host !== 'string') ||
    (value.exitCode !== null && typeof value.exitCode !== 'number')
  ) {
    return null;
  }
  return {
    version: 1,
    id: value.id,
    kind: 'passthrough',
    atMs: value.atMs,
    argv: value.argv,
    cwd: value.cwd,
    session: value.session,
    host: value.host,
    exitCode: value.exitCode,
  };
};

/** A failing ledger is a defect, not a recoverable condition, so nothing here has a typed error. */
export const createLedgerApi = (db: DatabaseSync): LedgerApi => {
  const insertTransition = db.prepare(
    'INSERT INTO transitions (request_id, at_ms, from_status, to_status) VALUES (?, ?, ?, ?)',
  );
  const selectStatus = db.prepare('SELECT status FROM requests WHERE id = ?');
  const selectRequest = db.prepare(`SELECT ${requestColumns} FROM requests WHERE id = ?`);
  const insertAttemptStatement = db.prepare(
    `INSERT OR IGNORE INTO requests (
       created_at_ms, session, host, cwd, workspace_root, target_dir, lane_key, argv_json,
       intent_key, intent_json, status, finished_at_ms, exit_code, error, source_attempt_id
     ) VALUES (?, ?, ?, ?, ?, '', 'attempt', ?, NULL, NULL, ?, ?, ?, ?, ?)`,
  );
  const selectAttemptBySource = db.prepare(
    'SELECT id FROM requests WHERE source_attempt_id = ?',
  );
  const insertRequest = db.prepare(
    `INSERT INTO requests (created_at_ms, session, host, cwd, workspace_root, target_dir,
       lane_key, argv_json, intent_key, intent_json, status, background, hold_stop, estimate_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const updateQueued = db.prepare(
    'UPDATE requests SET status = ?, queued_at_ms = ? WHERE id = ?',
  );
  const updateRunning = db.prepare(
    `UPDATE requests
     SET status = ?,
         started_at_ms = ?,
         wait_ms = CASE
           WHEN attached_to IS NOT NULL THEN MAX(0, ? - created_at_ms)
           WHEN queued_at_ms IS NULL THEN NULL
           ELSE MAX(0, ? - queued_at_ms)
         END,
         exec_argv_json = ?
     WHERE id = ? AND ${notTerminalFilter}`,
  );
  const updateAttached = db.prepare(
    `UPDATE requests
     SET status = 'queued',
         queued_at_ms = COALESCE(queued_at_ms, created_at_ms),
         started_at_ms = NULL,
         wait_ms = NULL,
         attached_to = ?,
         attach_mode = ?
     WHERE id = ? AND ${notTerminalFilter}`,
  );
  const updateRequeued = db.prepare(
    `UPDATE requests
     SET status = 'queued',
         queued_at_ms = ?,
         started_at_ms = NULL,
         wait_ms = NULL,
         attached_to = NULL,
         attach_mode = NULL
     WHERE id = ?`,
  );
  const updateFinished = db.prepare(
    `UPDATE requests
     SET status = ?,
         finished_at_ms = ?,
         run_ms = CASE
           WHEN started_at_ms IS NULL THEN NULL
           ELSE MAX(0, ? - started_at_ms)
         END,
         exit_code = ?,
         signal = ?,
         output_tail = ?,
         error = ?,
         error_count = ?,
         warning_count = ?,
         diagnostics_json = ?,
         saved_compute_ms = ?,
         saved_compute_source = ?,
         saved_latency_ms = ?
     WHERE id = ?`,
  );
  const selectAttachmentSavingsByMode = db.prepare(
    `SELECT
       attach_mode AS mode,
       COUNT(*) AS riders_served,
       SUM(saved_compute_ms) AS saved_compute_ms,
       SUM(CASE WHEN saved_compute_source = 'exact' THEN saved_compute_ms ELSE 0 END) AS saved_compute_exact_ms,
       SUM(CASE WHEN saved_compute_source = 'estimate' THEN saved_compute_ms ELSE 0 END) AS saved_compute_estimated_ms,
       SUM(saved_latency_ms) AS saved_latency_ms,
       SUM(CASE WHEN saved_latency_ms < 0 THEN 1 ELSE 0 END) AS negative_latency_riders
     FROM requests
     WHERE attached_to IS NOT NULL
       AND attach_mode IS NOT NULL
       AND saved_compute_ms IS NOT NULL
       AND saved_latency_ms IS NOT NULL
     GROUP BY attach_mode`,
  );
  const selectRecentDurations = db.prepare(
    `SELECT run_ms FROM requests
     WHERE intent_key = ? AND status = 'done' AND run_ms IS NOT NULL
       AND attached_to IS NULL
     ORDER BY id DESC LIMIT ?`,
  );
  const selectSessionPending = db.prepare(
    `SELECT id, created_at_ms, estimate_ms, hold_stop, started_at_ms, status
     FROM requests
     WHERE session = ? AND hold_stop = 1 AND ${activeStatusFilter}
     ORDER BY created_at_ms ASC, id ASC`,
  );
  // Only background (or detached) tickets: a foreground ticket streamed its
  // exit to the shell the agent just watched, so re-announcing it would only
  // prompt a redundant `hauler_result`.
  const selectSessionCompleted = db.prepare(
    `SELECT id, status, exit_code, error, error_count, warning_count
     FROM requests
     WHERE session = ? AND finished_at_ms >= ?
       AND status IN ('done', 'failed', 'killed')
       AND background = 1
     ORDER BY created_at_ms DESC, id DESC`,
  );
  const updateDetached = db.prepare('UPDATE requests SET background = 1 WHERE id = ?');
  const selectRecentRequests = db.prepare(
    `SELECT ${requestColumns} FROM requests ORDER BY created_at_ms DESC, id DESC LIMIT ?`,
  );
  const selectRecentStatusRequests = db.prepare(
    `SELECT ${statusRequestColumns} FROM requests ORDER BY created_at_ms DESC, id DESC LIMIT ?`,
  );
  const selectMetricsWindowAll = db.prepare(
    `SELECT
       status,
       finished_at_ms,
       run_ms,
       wait_ms,
       COALESCE(json_extract(intent_json, '$.subcommand'), 'unknown') AS subcommand,
       json_extract(intent_json, '$.profile') AS profile
     FROM requests
     WHERE attached_to IS NULL
       AND run_ms IS NOT NULL
     ORDER BY finished_at_ms DESC, id DESC
     LIMIT ?`,
  );
  const selectMetricsWindowSince = db.prepare(
    `SELECT
       status,
       finished_at_ms,
       run_ms,
       wait_ms,
       COALESCE(json_extract(intent_json, '$.subcommand'), 'unknown') AS subcommand,
       json_extract(intent_json, '$.profile') AS profile
     FROM requests
     WHERE attached_to IS NULL
       AND run_ms IS NOT NULL
       AND finished_at_ms >= ?
     ORDER BY finished_at_ms DESC, id DESC
     LIMIT ?`,
  );
  const selectActiveRequests = db.prepare(
    `SELECT ${requestColumns} FROM requests
     WHERE ${activeStatusFilter}
     ORDER BY created_at_ms ASC, id ASC`,
  );
  const selectActiveStatusRequests = db.prepare(
    `SELECT ${statusRequestColumns} FROM requests
     WHERE ${activeStatusFilter}
     ORDER BY created_at_ms ASC, id ASC`,
  );
  const selectTransitions = db.prepare(
    `SELECT request_id, at_ms, from_status, to_status FROM transitions
     WHERE request_id = ?
     ORDER BY id ASC`,
  );
  const selectOrphans = db.prepare(
    `SELECT id, status FROM requests WHERE ${activeStatusFilter}`,
  );
  const updateOrphan = db.prepare(
    'UPDATE requests SET status = ?, finished_at_ms = ?, error = ? WHERE id = ?',
  );

  const withAllModes = (
    rows: readonly AttachmentSavingsModeReport[],
  ): readonly AttachmentSavingsModeReport[] => {
    const byMode = new Map(rows.map((row) => [row.mode, row] as const));
    return (['identity', 'coverage', 'batch'] as const).map((mode) => {
      const row = byMode.get(mode);
      return (
        row ?? {
          mode,
          ridersServed: 0,
          savedComputeMs: 0,
          savedComputeExactMs: 0,
          savedComputeEstimatedMs: 0,
          savedLatencyMs: 0,
          negativeLatencyRiders: 0,
        }
      );
    });
  };

  const totalsFrom = (
    byMode: readonly AttachmentSavingsModeReport[],
  ): AttachmentSavingsTotalsReport =>
    byMode.reduce<AttachmentSavingsTotalsReport>(
      (totals, row) => ({
        ridersServed: totals.ridersServed + row.ridersServed,
        savedComputeMs: totals.savedComputeMs + row.savedComputeMs,
        savedComputeExactMs: totals.savedComputeExactMs + row.savedComputeExactMs,
        savedComputeEstimatedMs: totals.savedComputeEstimatedMs + row.savedComputeEstimatedMs,
        savedLatencyMs: totals.savedLatencyMs + row.savedLatencyMs,
        negativeLatencyRiders: totals.negativeLatencyRiders + row.negativeLatencyRiders,
      }),
      {
        ridersServed: 0,
        savedComputeMs: 0,
        savedComputeExactMs: 0,
        savedComputeEstimatedMs: 0,
        savedLatencyMs: 0,
        negativeLatencyRiders: 0,
      },
    );

  const attachmentSavings = (): AttachmentSavingsReport => {
    const byMode = withAllModes(
      selectAttachmentSavingsByMode
        .all()
        .flatMap((row): readonly AttachmentSavingsModeReport[] => {
          const mode = toNullableText(row.mode);
          if (mode !== 'identity' && mode !== 'coverage' && mode !== 'batch') {
            return [];
          }
          return [
            {
              mode,
              ridersServed: toNumber(row.riders_served),
              savedComputeMs: toNumber(row.saved_compute_ms),
              savedComputeExactMs: toNumber(row.saved_compute_exact_ms),
              savedComputeEstimatedMs: toNumber(row.saved_compute_estimated_ms),
              savedLatencyMs: toNumber(row.saved_latency_ms),
              negativeLatencyRiders: toNumber(row.negative_latency_riders),
            },
          ];
        }),
    );
    return { byMode, totals: totalsFrom(byMode) };
  };

  /**
   * Leader-only metrics for dashboard windows. Followers do not represent
   * spawned work, and rows without run_ms never actually started, so both are
   * excluded for honest run/wait distributions.
   */
  const summarizeMetricsRows = (rows: readonly Row[]): MetricsWindowReport => {
    const runMs: number[] = [];
    const waitMs: number[] = [];
    const bySubcommand = new Map<string, number[]>();
    let done = 0;
    let failed = 0;
    let killed = 0;
    for (const row of rows) {
      const status = toText(row.status);
      switch (status) {
        case 'done':
          done += 1;
          break;
        case 'failed':
          failed += 1;
          break;
        case 'killed':
          killed += 1;
          break;
        default:
          break;
      }
      const run = toNullableNumber(row.run_ms);
      if (run !== null) {
        runMs.push(run);
        const subcommandText = toNullableText(row.subcommand);
        const subcommand =
          subcommandText === null || subcommandText.trim().length === 0
            ? 'unknown'
            : subcommandText;
        const profileText = toNullableText(row.profile);
        const profile =
          profileText === null || profileText.trim().length === 0
            ? defaultCargoProfile(subcommand)
            : profileText;
        const populationKey = `${subcommand}\0${profile}`;
        const samples = bySubcommand.get(populationKey) ?? [];
        samples.push(run);
        bySubcommand.set(populationKey, samples);
      }
      const wait = toNullableNumber(row.wait_ms);
      if (wait !== null) {
        waitMs.push(wait);
      }
    }
    runMs.sort((left, right) => left - right);
    waitMs.sort((left, right) => left - right);
    const bySubcommandRows = [...bySubcommand.entries()]
      .map(([populationKey, samples]): MetricsWindowBySubcommand => {
        const [subcommand = 'unknown', profile] = populationKey.split('\0');
        const sorted = [...samples].sort((left, right) => left - right);
        return {
          subcommand,
          ...(profile === undefined ? {} : { profile }),
          count: sorted.length,
          p50Ms: percentileFromSorted(sorted, 0.5),
          maxMs: sorted.length === 0 ? null : sorted[sorted.length - 1] ?? null,
        };
      })
      .sort(
        (left, right) =>
          right.count - left.count ||
          left.subcommand.localeCompare(right.subcommand) ||
          (left.profile ?? '').localeCompare(right.profile ?? ''),
      );
    return {
      count: runMs.length,
      done,
      failed,
      killed,
      runP50Ms: percentileFromSorted(runMs, 0.5),
      runP95Ms: percentileFromSorted(runMs, 0.95),
      runMeanMs: mean(runMs),
      waitP50Ms: percentileFromSorted(waitMs, 0.5),
      waitP95Ms: percentileFromSorted(waitMs, 0.95),
      bySubcommand: bySubcommandRows,
    };
  };

  const metricsWindow = (sinceMs: number | null): MetricsWindowReport =>
    summarizeMetricsRows(
      (sinceMs === null
        ? selectMetricsWindowAll.all(metricsWindowScanLimit)
        : selectMetricsWindowSince.all(sinceMs, metricsWindowScanLimit)) as readonly Row[],
    );

  let metricsWindowsCache:
    | { readonly expiresAtMs: number; readonly value: MetricsWindowsReport }
    | undefined;
  const metricsWindows = (nowMs: number): MetricsWindowsReport => {
    if (metricsWindowsCache !== undefined && metricsWindowsCache.expiresAtMs > nowMs) {
      return metricsWindowsCache.value;
    }
    const rows = selectMetricsWindowAll.all(metricsWindowScanLimit) as readonly Row[];
    const sinceHour = nowMs - 3_600_000;
    const sinceDay = nowMs - 86_400_000;
    const finishedAt = (row: Row): number => toNullableNumber(row.finished_at_ms) ?? 0;
    const value = {
      hour: summarizeMetricsRows(rows.filter((row) => finishedAt(row) >= sinceHour)),
      day: summarizeMetricsRows(rows.filter((row) => finishedAt(row) >= sinceDay)),
      all: summarizeMetricsRows(rows),
    };
    metricsWindowsCache = { expiresAtMs: nowMs + 5_000, value };
    return value;
  };

  const insertAttempt = (
    input: RecordAttemptInput,
  ): { readonly id: number; readonly ticket: string } => {
    const result = insertAttemptStatement.run(
      input.atMs,
      input.session,
      input.host,
      input.cwd,
      input.cwd,
      JSON.stringify(input.argv),
      input.status,
      input.atMs,
      input.exitCode ?? null,
      input.error ?? null,
      input.sourceAttemptId ?? null,
    );
    if (result.changes === 0 && input.sourceAttemptId !== undefined) {
      const existing = selectAttemptBySource.get(input.sourceAttemptId);
      if (existing !== undefined) {
        const id = toNumber(existing.id);
        return { id, ticket: formatTicket(id) };
      }
    }
    const id = Number(result.lastInsertRowid);
    recordTransition(insertTransition, id, input.atMs, null, input.status);
    return { id, ticket: formatTicket(id) };
  };

  const ingestPassthroughSpool = (stateDir: string): number => {
    mkdirSync(stateDir, { recursive: true });
    const spoolPath = join(stateDir, passthroughSpoolFileName);
    const drainPath = `${spoolPath}.drain`;
    if (!existsSync(drainPath)) {
      if (!existsSync(spoolPath)) {
        return 0;
      }
      try {
        renameSync(spoolPath, drainPath);
      } catch {
        return 0;
      }
    }
    const records = readFileSync(drainPath, 'utf8')
      .split('\n')
      .flatMap((line) => {
        if (line.trim().length === 0) {
          return [];
        }
        const parsed = parsePassthroughSpoolRecord(line);
        return parsed === null ? [] : [parsed];
      });
    let inserted = 0;
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const record of records) {
        if (selectAttemptBySource.get(record.id) !== undefined) {
          continue;
        }
        insertAttempt({
          argv: record.argv,
          atMs: record.atMs,
          cwd: record.cwd,
          exitCode: record.exitCode,
          host: record.host,
          session: record.session,
          sourceAttemptId: record.id,
          status: 'passthrough',
        });
        inserted += 1;
      }
      db.exec('COMMIT');
    } catch (cause) {
      db.exec('ROLLBACK');
      throw cause;
    }
    rmSync(drainPath, { force: true });
    return inserted;
  };

  return {
    createRequest: (input) =>
      Effect.sync(() => {
        const result = insertRequest.run(
          input.createdAtMs,
          input.session,
          input.host,
          input.cwd,
          input.workspaceRoot,
          input.targetDir,
          input.laneKey,
          JSON.stringify(input.argv),
          input.intentKey,
          input.intentJson,
          'requested',
          input.background === true ? 1 : 0,
          input.holdStop === true ? 1 : 0,
          input.estimateMs ?? null,
        );
        const id = Number(result.lastInsertRowid);
        recordTransition(insertTransition, id, input.createdAtMs, null, 'requested');
        return { id, ticket: formatTicket(id) };
      }),

    markQueued: (id, atMs) =>
      Effect.sync(() => {
        updateQueued.run('queued', atMs, id);
        recordTransition(insertTransition, id, atMs, 'requested', 'queued');
      }),

    markRunning: (id, atMs, execArgv) =>
      Effect.sync(() => {
        const result = updateRunning.run(
          'running',
          atMs,
          atMs,
          atMs,
          execArgv === undefined ? null : JSON.stringify(execArgv),
          id,
        );
        if (result.changes > 0) {
          recordTransition(insertTransition, id, atMs, 'queued', 'running');
        }
      }),

    markAttached: (id, input) =>
      Effect.sync(() => {
        const fromStatus = readStatus(selectStatus, id);
        const result = updateAttached.run(input.leaderTicket, input.mode, id);
        if (result.changes > 0 && fromStatus !== 'queued') {
          recordTransition(insertTransition, id, input.atMs, fromStatus, 'queued');
        }
      }),

    markRequeued: (id, atMs) =>
      Effect.sync(() => {
        const fromStatus = readStatus(selectStatus, id);
        updateRequeued.run(atMs, id);
        recordTransition(insertTransition, id, atMs, fromStatus, 'queued');
      }),

    markFinished: (id, input) =>
      Effect.sync(() => {
        const fromStatus = readStatus(selectStatus, id);
        updateFinished.run(
          input.status,
          input.atMs,
          input.atMs,
          input.exitCode ?? null,
          input.signal ?? null,
          input.outputTail ?? null,
          input.error ?? null,
          input.errorCount ?? null,
          input.warningCount ?? null,
          input.diagnostics == null ? null : JSON.stringify(input.diagnostics),
          input.savedComputeMs ?? null,
          input.savedComputeSource ?? null,
          input.savedLatencyMs ?? null,
          id,
        );
        recordTransition(insertTransition, id, input.atMs, fromStatus, input.status);
      }),

    markDetached: (id) => Effect.sync(() => toNumber(updateDetached.run(id).changes) > 0),

    recordAttempt: (input) => Effect.sync(() => insertAttempt(input)),

    ingestPassthroughSpool: (stateDir) => Effect.sync(() => ingestPassthroughSpool(stateDir)),

    getRequest: (id) => Effect.sync(() => selectRequestById(selectRequest, id)),

    getRequestByTicket: (ticket) =>
      Effect.sync(() => {
        const id = parseTicket(ticket);
        return id === null ? null : selectRequestById(selectRequest, id);
      }),

    recentDurations: (intentKey, limit) =>
      Effect.sync(() =>
        selectRecentDurations.all(intentKey, limit).map((row) => toNumber(row.run_ms)),
      ),

    sessionPending: (session) =>
      Effect.sync(() =>
        selectSessionPending.all(session).map((row) => {
          const id = toNumber(row.id);
          return {
            createdAtMs: toNumber(row.created_at_ms),
            estimateMs: toNullableNumber(row.estimate_ms),
            holdStop: toNumber(row.hold_stop) !== 0,
            startedAtMs: toNullableNumber(row.started_at_ms),
            status: toText(row.status) as RequestStatus,
            ticket: formatTicket(id),
          };
        }),
      ),

    sessionCompleted: (session, sinceMs) =>
      Effect.sync(() =>
        selectSessionCompleted.all(session, sinceMs).map((row) => {
          const id = toNumber(row.id);
          return {
            error: toNullableText(row.error),
            errorCount: toNullableNumber(row.error_count),
            exitCode: toNullableNumber(row.exit_code),
            status: toText(row.status) as FinishedStatus,
            ticket: formatTicket(id),
            warningCount: toNullableNumber(row.warning_count),
          };
        }),
      ),

    recentRequests: (limit) =>
      Effect.sync(() => selectRecentRequests.all(limit).map(toRequestRecord)),

    activeRequests: () =>
      Effect.sync(() => selectActiveRequests.all().map(toRequestRecord)),

    recentStatusRequests: (limit) =>
      Effect.sync(() => selectRecentStatusRequests.all(limit).map(toRequestRecord)),

    activeStatusRequests: () =>
      Effect.sync(() => selectActiveStatusRequests.all().map(toRequestRecord)),

    transitionsFor: (id) =>
      Effect.sync(() => selectTransitions.all(id).map(toTransitionRecord)),

    reapOrphans: (atMs, error) =>
      Effect.sync(() => {
        const orphans = selectOrphans.all();
        for (const row of orphans) {
          const id = toNumber(row.id);
          updateOrphan.run('killed', atMs, error, id);
          recordTransition(
            insertTransition,
            id,
            atMs,
            toText(row.status) as RequestStatus,
            'killed',
          );
        }
        return orphans.length;
      }),

    attachmentSavings: () => Effect.sync(() => attachmentSavings()),

    metricsWindow: (sinceMs) => Effect.sync(() => metricsWindow(sinceMs)),
    metricsWindows: (nowMs) => Effect.sync(() => metricsWindows(nowMs)),
  };
};

export const LedgerLive: Layer.Layer<Ledger, never, DaemonConfig> = Layer.effect(
  Ledger,
  Effect.gen(function* () {
    const config = yield* DaemonConfig;
    const db = yield* Effect.acquireRelease(
      Effect.sync(() => openLedgerDatabase(config.databasePath)),
      (database) =>
        Effect.sync(() => {
          database.close();
        }),
    );
    return createLedgerApi(db);
  }),
);
