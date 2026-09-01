import { z } from 'zod';

export { LineBuffer } from '../lib/ndjson.js';

/**
 * Wire protocol for the conductor daemon: one JSON document per line
 * (NDJSON) in each direction over the daemon's unix socket. This module is
 * the shared vocabulary between the daemon, the control/exec clients, and
 * the ledger, so it must not import from the other daemon modules.
 */

export type RequestStatus =
  | 'requested'
  | 'queued'
  | 'running'
  | 'done'
  | 'failed'
  | 'killed'
  | 'denied'
  | 'passthrough';

/** Terminal statuses a request can end in. */
export type FinishedStatus = 'done' | 'failed' | 'killed';

/**
 * How an attached request rides its leader (see daemon/coverage.ts):
 * 'identity' mirrors everything, 'coverage' rides a stronger in-flight run,
 * 'batch' was composed into a merged invocation. Coverage and compile-batch
 * attachments requeue when the leader fails (unless their scope was proven);
 * folded test/nextest batches mirror the composite's shared exit.
 */
export type AttachMode = 'identity' | 'coverage' | 'batch';

/** One ledgered cargo request, as stored in SQLite and reported over the socket. */
export interface RequestRecord {
  readonly id: number;
  readonly ticket: string;
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
  readonly status: RequestStatus;
  readonly queuedAtMs: number | null;
  readonly startedAtMs: number | null;
  readonly finishedAtMs: number | null;
  readonly waitMs: number | null;
  readonly runMs: number | null;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly outputTail: string | null;
  readonly error: string | null;
  readonly errorCount: number | null;
  readonly warningCount: number | null;
  readonly diagnostics: readonly string[] | null;
  /** Leader ticket when this request was served by attaching to another run. */
  readonly attachedTo: string | null;
  readonly attachMode: AttachMode | null;
  /** The invocation actually spawned (demux flag, batch-folded -p packages); null until run. */
  readonly execArgv: readonly string[] | null;
  readonly background: boolean;
  readonly holdStop: boolean;
  readonly estimateMs: number | null;
}

export interface TransitionRecord {
  readonly requestId: number;
  readonly atMs: number;
  readonly fromStatus: RequestStatus | null;
  readonly toStatus: RequestStatus;
}

export const execRequestSchema = z.object({
  type: z.literal('exec'),
  id: z.string().min(1),
  argv: z.array(z.string()).min(1),
  cwd: z.string().min(1),
  workspaceRoot: z.string().min(1).optional(),
  env: z.record(z.string(), z.string()).optional(),
  session: z.string().optional(),
  host: z.string().optional(),
  background: z.boolean().optional(),
  holdStop: z.boolean().optional(),
});

export const attemptRequestSchema = z.object({
  type: z.literal('attempt'),
  id: z.string().min(1),
  kind: z.literal('denied'),
  argv: z.array(z.string()).min(1),
  cwd: z.string().min(1),
  session: z.string().optional(),
  host: z.string().optional(),
  reason: z.string().min(1),
});

export const detachRequestSchema = z.object({
  type: z.literal('detach'),
  id: z.string().min(1),
  ticket: z.string().min(1),
});

/** Await ceiling (2h) — the single source for daemon wire and operation schemas. */
export const awaitCeilingMs = 7_200_000;

export const awaitRequestSchema = z.object({
  type: z.literal('await'),
  id: z.string().min(1),
  ticket: z.string().min(1),
  maxWaitMs: z.number().int().min(0).max(awaitCeilingMs).optional(),
});

export const resultRequestSchema = z.object({
  type: z.literal('result'),
  id: z.string().min(1),
  ticket: z.string().min(1),
});

export const sessionPendingRequestSchema = z.object({
  type: z.literal('session-pending'),
  id: z.string().min(1),
  session: z.string().min(1),
});

export const sessionCompletedRequestSchema = z.object({
  type: z.literal('session-completed'),
  id: z.string().min(1),
  session: z.string().min(1),
  sinceMs: z.number().int().min(0),
});

export const killRequestSchema = z.object({
  type: z.literal('kill'),
  id: z.string().min(1),
  ticket: z.string().min(1),
});

export const statusRequestSchema = z.object({
  type: z.literal('status'),
  id: z.string().min(1),
  limit: z.number().int().min(1).max(500).optional(),
});

export const pingRequestSchema = z.object({
  type: z.literal('ping'),
  id: z.string().min(1),
});

export const shutdownRequestSchema = z.object({
  type: z.literal('shutdown'),
  id: z.string().min(1),
});

export const clientMessageSchema = z.discriminatedUnion('type', [
  execRequestSchema,
  attemptRequestSchema,
  detachRequestSchema,
  awaitRequestSchema,
  resultRequestSchema,
  sessionPendingRequestSchema,
  sessionCompletedRequestSchema,
  killRequestSchema,
  statusRequestSchema,
  pingRequestSchema,
  shutdownRequestSchema,
]);

export type ExecRequest = z.infer<typeof execRequestSchema>;
export type AttemptRequest = z.infer<typeof attemptRequestSchema>;
export type DetachRequest = z.infer<typeof detachRequestSchema>;
export type AwaitRequest = z.infer<typeof awaitRequestSchema>;
export type ResultRequest = z.infer<typeof resultRequestSchema>;
export type SessionPendingRequest = z.infer<typeof sessionPendingRequestSchema>;
export type SessionCompletedRequest = z.infer<typeof sessionCompletedRequestSchema>;
export type KillRequest = z.infer<typeof killRequestSchema>;
export type StatusRequest = z.infer<typeof statusRequestSchema>;
export type PingRequest = z.infer<typeof pingRequestSchema>;
export type ShutdownRequest = z.infer<typeof shutdownRequestSchema>;
export type ClientMessage = z.infer<typeof clientMessageSchema>;

export interface LaneStatus {
  readonly key: string;
  readonly workspaceRoot: string;
  readonly targetDir: string;
  readonly queued: number;
  readonly runningTicket: string | null;
}

export interface HistogramMetricSnapshot {
  /** A null boundary is the histogram's positive-infinity bucket. */
  readonly buckets: readonly (readonly [boundary: number | null, count: number])[];
  readonly count: number;
  readonly min: number | null;
  readonly max: number | null;
  readonly sum: number;
}

export interface StatusMetrics {
  readonly cargo_run_ms: HistogramMetricSnapshot;
  readonly cargo_run_ms_by_kind?: Readonly<Record<string, HistogramMetricSnapshot>>;
  readonly job_outcome: Readonly<Record<string, number>>;
  readonly attach_mode: Readonly<Record<string, number>>;
  readonly wait_ms_summary?: {
    readonly count: number;
    readonly min: number | null;
    readonly max: number | null;
    readonly sum: number;
    readonly quantiles: ReadonlyArray<readonly [number, number | null]>;
  };
}

export interface KacheHeartbeatRoot {
  readonly root: string;
  readonly count: number;
}

export interface KacheTopCrate {
  readonly crate: string;
  readonly profile: string;
  readonly ms: number;
}

export interface KacheStatusReport {
  readonly available: boolean;
  readonly entryCount: number;
  readonly distinctCrates: number;
  readonly indexSizeBytes: number;
  readonly eventsFreshMs: number | null;
  readonly recentHeartbeatRoots: readonly KacheHeartbeatRoot[];
  readonly topCrates: readonly KacheTopCrate[];
}

export interface StatusReport {
  readonly pid: number;
  readonly startedAtMs: number;
  readonly socketPath: string;
  readonly maxConcurrent: number;
  readonly lanes: readonly LaneStatus[];
  readonly active: readonly RequestRecord[];
  readonly recent: readonly RequestRecord[];
  readonly metrics?: StatusMetrics;
  readonly kache?: KacheStatusReport | null;
  readonly system?: SystemLoadReport;
}

/** Busy share of one device backing the state dir or an in-flight target dir. */
export interface DiskUtilReport {
  readonly device: string;
  /** Percent of wall time (0–100) the device had I/O in flight since the previous sample. */
  readonly utilPercent: number;
}

/** Machine load at report time, for dashboards and clamp visibility. */
export interface SystemLoadReport {
  readonly loadAvg1: number;
  readonly cores: number;
  /** Configured per-core clamp threshold, or null when the clamp is off. */
  readonly clampThresholdPerCore: number | null;
  /**
   * iowait share (0–100) of CPU time since the previous status sample.
   * Linux only, and only once a delta exists: absent means "no honest
   * number", never zero. High iowait beside a modest loadavg is the
   * disk-stalled-build tell.
   */
  readonly ioWaitPercent?: number;
  /** Busy share of devices backing the state dir and in-flight target dirs (Linux only). */
  readonly disks?: readonly DiskUtilReport[];
}

/**
 * Sent once the request is ledgered and queued. Delivery order relative to
 * 'started' is not guaranteed: a job on an idle lane can start (from the lane
 * worker fiber) before the submitting fiber flushes the ack.
 */
export interface AckMessage {
  readonly type: 'ack';
  readonly id: string;
  readonly ticket: string;
  readonly laneKey: string;
  /** Jobs ahead of this one in its lane queue at submission time. */
  readonly position: number;
  /** Present when the request attached to an in-flight leader instead of queueing. */
  readonly attachedTo?: string;
  readonly attachMode?: AttachMode;
  /** Estimated remaining runtime for this queued request or its attached leader. */
  readonly etaMs?: number;
}

/**
 * Sent when an attached request loses its leader (failed or killed stronger
 * run) and goes back to the lane queue to execute on its own.
 */
export interface RequeuedMessage {
  readonly type: 'requeued';
  readonly id: string;
  readonly ticket: string;
  readonly reason: string;
}

export interface StartedMessage {
  readonly type: 'started';
  readonly id: string;
  readonly ticket: string;
  readonly waitMs: number;
}

export interface OutputMessage {
  readonly type: 'output';
  readonly id: string;
  readonly ticket: string;
  readonly channel: 'stdout' | 'stderr';
  /** Base64-encoded bytes so arbitrary cargo output survives JSON framing. */
  readonly data: string;
}

export interface ExitMessage {
  readonly type: 'exit';
  readonly id: string;
  readonly ticket: string;
  readonly status: FinishedStatus;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly waitMs: number;
  readonly runMs: number;
  readonly error: string | null;
}

export interface KillResultMessage {
  readonly type: 'kill-result';
  readonly id: string;
  readonly ticket: string;
  readonly killed: boolean;
}

export interface PongMessage {
  readonly type: 'pong';
  readonly id: string;
  readonly pid: number;
  readonly startedAtMs: number;
  readonly version: string;
}

export interface StatusResultMessage {
  readonly type: 'status-result';
  readonly id: string;
  readonly report: StatusReport;
}

export interface ShuttingDownMessage {
  readonly type: 'shutting-down';
  readonly id: string;
}

export interface AttemptRecordedMessage {
  readonly type: 'attempt-recorded';
  readonly id: string;
  readonly ticket: string;
}

export interface ErrorMessage {
  readonly type: 'error';
  readonly id: string | null;
  readonly code: 'bad-message' | 'bad-intent' | 'internal';
  readonly message: string;
}

export interface DetachResultMessage {
  readonly type: 'detach-result';
  readonly id: string;
  readonly ticket: string;
  readonly detached: boolean;
}

export interface AwaitResultMessage {
  readonly type: 'await-result';
  readonly id: string;
  readonly request: RequestRecord | null;
  readonly timedOut: boolean;
}

export interface ResultResultMessage {
  readonly type: 'result-result';
  readonly id: string;
  readonly request: RequestRecord | null;
}

export interface SessionPendingResultMessage {
  readonly type: 'session-pending-result';
  readonly id: string;
  readonly requests: readonly RequestRecord[];
}

export interface SessionCompletedResultMessage {
  readonly type: 'session-completed-result';
  readonly id: string;
  readonly requests: readonly RequestRecord[];
}

export type ServerMessage =
  | AckMessage
  | AttemptRecordedMessage
  | RequeuedMessage
  | StartedMessage
  | OutputMessage
  | ExitMessage
  | KillResultMessage
  | PongMessage
  | StatusResultMessage
  | ShuttingDownMessage
  | ErrorMessage
  | DetachResultMessage
  | AwaitResultMessage
  | ResultResultMessage
  | SessionPendingResultMessage
  | SessionCompletedResultMessage;

export const encodeServerMessage = (message: ServerMessage): string =>
  `${JSON.stringify(message)}\n`;

export const encodeClientMessage = (message: ClientMessage): string =>
  `${JSON.stringify(message)}\n`;

/** The daemon is a trusted local peer; clients parse its lines without schema checks. */
export const parseServerMessageLine = (line: string): ServerMessage =>
  JSON.parse(line) as ServerMessage;

export const formatTicket = (id: number): string => `cc-${id}`;

const ticketPattern = /^cc-(\d+)$/u;

export const parseTicket = (ticket: string): number | null => {
  const match = ticketPattern.exec(ticket);
  return match === null ? null : Number(match[1]);
};

export const passthroughSpoolFileName = 'passthrough-attempts.v1.jsonl';

export interface PassthroughSpoolRecord {
  readonly version: 1;
  readonly id: string;
  readonly kind: 'passthrough';
  readonly atMs: number;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly session: string | null;
  readonly host: string | null;
  readonly exitCode: number | null;
}
