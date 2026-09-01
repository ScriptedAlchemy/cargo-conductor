import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';

import * as Effect from 'effect/Effect';

import { resolveDaemonConfig } from './daemon/config.js';
import type { DaemonConfigShape } from './daemon/config.js';
import { requestOverSocket } from './daemon/control.js';
import { createLedgerApi, openLedgerDatabase, openLedgerDatabaseReadOnly } from './daemon/ledger.js';
import type { LaneStatus, RequestRecord, StatusReport, StatusResultMessage } from './daemon/protocol.js';

export interface ConductorSnapshot {
  readonly active: readonly RequestRecord[];
  readonly daemon: 'running' | 'stopped';
  readonly lanes: readonly LaneStatus[];
  readonly maxConcurrent: number | null;
  readonly pid: number | null;
  readonly recent: readonly RequestRecord[];
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

const shortId = (): string => randomBytes(6).toString('hex');

const requestWord = (count: number): string => (count === 1 ? 'request' : 'requests');

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

const fromReport = (report: StatusReport, config: DaemonConfigShape): ConductorSnapshot => ({
  active: report.active,
  daemon: 'running',
  lanes: report.lanes,
  maxConcurrent: report.maxConcurrent,
  pid: report.pid,
  recent: report.recent,
  socketPath: report.socketPath,
  startedAtMs: report.startedAtMs,
  stateRoot: config.stateDir,
  summary: runningSummary(report),
});

const emptyStopped = (config: DaemonConfigShape): ConductorSnapshot => ({
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
});

const snapshotFrom = (db: DatabaseSync, config: DaemonConfigShape, recentLimit: number): ConductorSnapshot => {
  try {
    const ledger = createLedgerApi(db);
    const recent = Effect.runSync(ledger.recentRequests(recentLimit));
    const active = Effect.runSync(ledger.activeRequests());
    return {
      active,
      daemon: 'stopped',
      lanes: [],
      maxConcurrent: null,
      pid: null,
      recent,
      socketPath: config.socketPath,
      startedAtMs: null,
      stateRoot: config.stateDir,
      summary: stoppedSummary(recent.length),
    };
  } finally {
    db.close();
  }
};

const fromLedger = (config: DaemonConfigShape, recentLimit: number): ConductorSnapshot => {
  if (!existsSync(config.databasePath)) {
    return emptyStopped(config);
  }
  try {
    return snapshotFrom(openLedgerDatabaseReadOnly(config.databasePath), config, recentLimit);
  } catch {
    // WAL recovery after an unclean stop, or a ledger predating a column
    // migration, needs the writable opener.
    return snapshotFrom(openLedgerDatabase(config.databasePath), config, recentLimit);
  }
};

export const loadConductorSnapshot = (
  options: LoadSnapshotOptions = {},
): Effect.Effect<ConductorSnapshot> => {
  const config = options.config ?? resolveDaemonConfig();
  const recentLimit = options.recentLimit ?? defaultRecentLimit;
  return requestOverSocket({
    isTerminal: (message) => message.type === 'status-result',
    message: { id: shortId(), limit: recentLimit, type: 'status' },
    socketPath: config.socketPath,
    timeoutMs: 2_000,
  }).pipe(
    Effect.map((messages) => {
      const result = messages.find(
        (message): message is StatusResultMessage => message.type === 'status-result',
      );
      return result === undefined ? fromLedger(config, recentLimit) : fromReport(result.report, config);
    }),
    Effect.catchAll(() => Effect.sync(() => fromLedger(config, recentLimit))),
  );
};
