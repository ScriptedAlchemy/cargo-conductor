import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';

import { DaemonConfig } from './config.js';
import { formatTicket } from './protocol.js';
import type {
  FinishedStatus,
  RequestRecord,
  RequestStatus,
  TransitionRecord,
} from './protocol.js';

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
}

export interface FinishRequestInput {
  readonly status: FinishedStatus;
  readonly atMs: number;
  readonly exitCode?: number | null;
  readonly signal?: string | null;
  readonly outputTail?: string | null;
  readonly error?: string | null;
}

export interface LedgerApi {
  readonly createRequest: (
    input: CreateRequestInput,
  ) => Effect.Effect<{ readonly id: number; readonly ticket: string }>;
  readonly markQueued: (id: number, atMs: number) => Effect.Effect<void>;
  readonly markRunning: (id: number, atMs: number) => Effect.Effect<void>;
  readonly markFinished: (id: number, input: FinishRequestInput) => Effect.Effect<void>;
  readonly getRequest: (id: number) => Effect.Effect<RequestRecord | null>;
  readonly getRequestByTicket: (ticket: string) => Effect.Effect<RequestRecord | null>;
  readonly recentRequests: (limit: number) => Effect.Effect<readonly RequestRecord[]>;
  readonly activeRequests: () => Effect.Effect<readonly RequestRecord[]>;
  readonly transitionsFor: (id: number) => Effect.Effect<readonly TransitionRecord[]>;
  readonly reapOrphans: (atMs: number, error: string) => Effect.Effect<number>;
}

export class Ledger extends Context.Tag('cargo-conductor/Ledger')<Ledger, LedgerApi>() {}

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
CREATE TABLE IF NOT EXISTS transitions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id INTEGER NOT NULL,
  at_ms INTEGER NOT NULL,
  from_status TEXT,
  to_status TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS requests_status_idx ON requests (status);
CREATE INDEX IF NOT EXISTS requests_created_at_ms_idx ON requests (created_at_ms);
CREATE INDEX IF NOT EXISTS transitions_request_id_idx ON transitions (request_id);
`;

const requestColumns = `id, created_at_ms, session, host, cwd, workspace_root, target_dir, lane_key,
  argv_json, intent_key, intent_json, status, queued_at_ms, started_at_ms, finished_at_ms, wait_ms,
  run_ms, exit_code, signal, output_tail, error`;

const activeStatusFilter = "status IN ('requested', 'queued', 'running')";

const ticketPattern = /^cc-(\d+)$/u;

type Row = Record<string, unknown>;

const toNumber = (value: unknown): number => Number(value);

const toNullableNumber = (value: unknown): number | null =>
  value === null || value === undefined ? null : Number(value);

const toText = (value: unknown): string => String(value);

const toNullableText = (value: unknown): string | null =>
  value === null || value === undefined ? null : String(value);

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
  };
};

const toTransitionRecord = (row: Row): TransitionRecord => ({
  requestId: toNumber(row.request_id),
  atMs: toNumber(row.at_ms),
  fromStatus: toNullableText(row.from_status) as RequestStatus | null,
  toStatus: toText(row.to_status) as RequestStatus,
});

const parseTicket = (ticket: string): number | null => {
  const match = ticketPattern.exec(ticket);
  return match === null ? null : Number(match[1]);
};

const recordTransition = (
  db: DatabaseSync,
  requestId: number,
  atMs: number,
  fromStatus: RequestStatus | null,
  toStatus: RequestStatus,
): void => {
  db.prepare(
    'INSERT INTO transitions (request_id, at_ms, from_status, to_status) VALUES (?, ?, ?, ?)',
  ).run(requestId, atMs, fromStatus, toStatus);
};

const readStatus = (db: DatabaseSync, id: number): RequestStatus | null => {
  const row = db.prepare('SELECT status FROM requests WHERE id = ?').get(id);
  return row === undefined ? null : (toText(row.status) as RequestStatus);
};

const selectRequestById = (db: DatabaseSync, id: number): RequestRecord | null => {
  const row = db.prepare(`SELECT ${requestColumns} FROM requests WHERE id = ?`).get(id);
  return row === undefined ? null : toRequestRecord(row);
};

export const openLedgerDatabase = (databasePath: string): DatabaseSync => {
  mkdirSync(dirname(databasePath), { recursive: true });
  const db = new DatabaseSync(databasePath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec(schemaStatements);
  return db;
};

/** A failing ledger is a defect, not a recoverable condition, so nothing here has a typed error. */
export const createLedgerApi = (db: DatabaseSync): LedgerApi => ({
  createRequest: (input) =>
    Effect.sync(() => {
      const result = db
        .prepare(
          `INSERT INTO requests (created_at_ms, session, host, cwd, workspace_root, target_dir,
             lane_key, argv_json, intent_key, intent_json, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
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
        );
      const id = Number(result.lastInsertRowid);
      recordTransition(db, id, input.createdAtMs, null, 'requested');
      return { id, ticket: formatTicket(id) };
    }),

  markQueued: (id, atMs) =>
    Effect.sync(() => {
      db.prepare('UPDATE requests SET status = ?, queued_at_ms = ? WHERE id = ?').run(
        'queued',
        atMs,
        id,
      );
      recordTransition(db, id, atMs, 'requested', 'queued');
    }),

  markRunning: (id, atMs) =>
    Effect.sync(() => {
      db.prepare(
        `UPDATE requests
         SET status = ?,
             started_at_ms = ?,
             wait_ms = CASE WHEN queued_at_ms IS NULL THEN NULL ELSE ? - queued_at_ms END
         WHERE id = ?`,
      ).run('running', atMs, atMs, id);
      recordTransition(db, id, atMs, 'queued', 'running');
    }),

  markFinished: (id, input) =>
    Effect.sync(() => {
      const fromStatus = readStatus(db, id);
      db.prepare(
        `UPDATE requests
         SET status = ?,
             finished_at_ms = ?,
             run_ms = CASE WHEN started_at_ms IS NULL THEN NULL ELSE ? - started_at_ms END,
             exit_code = ?,
             signal = ?,
             output_tail = ?,
             error = ?
         WHERE id = ?`,
      ).run(
        input.status,
        input.atMs,
        input.atMs,
        input.exitCode ?? null,
        input.signal ?? null,
        input.outputTail ?? null,
        input.error ?? null,
        id,
      );
      recordTransition(db, id, input.atMs, fromStatus, input.status);
    }),

  getRequest: (id) => Effect.sync(() => selectRequestById(db, id)),

  getRequestByTicket: (ticket) =>
    Effect.sync(() => {
      const id = parseTicket(ticket);
      return id === null ? null : selectRequestById(db, id);
    }),

  recentRequests: (limit) =>
    Effect.sync(() =>
      db
        .prepare(
          `SELECT ${requestColumns} FROM requests ORDER BY created_at_ms DESC, id DESC LIMIT ?`,
        )
        .all(limit)
        .map(toRequestRecord),
    ),

  activeRequests: () =>
    Effect.sync(() =>
      db
        .prepare(
          `SELECT ${requestColumns} FROM requests
           WHERE ${activeStatusFilter}
           ORDER BY created_at_ms ASC, id ASC`,
        )
        .all()
        .map(toRequestRecord),
    ),

  transitionsFor: (id) =>
    Effect.sync(() =>
      db
        .prepare(
          `SELECT request_id, at_ms, from_status, to_status FROM transitions
           WHERE request_id = ?
           ORDER BY id ASC`,
        )
        .all(id)
        .map(toTransitionRecord),
    ),

  reapOrphans: (atMs, error) =>
    Effect.sync(() => {
      const orphans = db
        .prepare(`SELECT id, status FROM requests WHERE ${activeStatusFilter}`)
        .all();
      const update = db.prepare(
        'UPDATE requests SET status = ?, finished_at_ms = ?, error = ? WHERE id = ?',
      );
      for (const row of orphans) {
        const id = toNumber(row.id);
        update.run('killed', atMs, error, id);
        recordTransition(db, id, atMs, toText(row.status) as RequestStatus, 'killed');
      }
      return orphans.length;
    }),
});

export const LedgerLive: Layer.Layer<Ledger, never, DaemonConfig> = Layer.scoped(
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
