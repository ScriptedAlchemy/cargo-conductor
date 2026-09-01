import { z } from 'zod';

/**
 * Wire protocol for the conductor daemon: one JSON document per line
 * (NDJSON) in each direction over the daemon's unix socket. This module is
 * the shared vocabulary between the daemon, the control/exec clients, and
 * the ledger, so it must not import from the other daemon modules.
 */

export type RequestStatus = 'requested' | 'queued' | 'running' | 'done' | 'failed' | 'killed';

/** Terminal statuses a request can end in. */
export type FinishedStatus = 'done' | 'failed' | 'killed';

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
  killRequestSchema,
  statusRequestSchema,
  pingRequestSchema,
  shutdownRequestSchema,
]);

export type ExecRequest = z.infer<typeof execRequestSchema>;
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

export interface StatusReport {
  readonly pid: number;
  readonly startedAtMs: number;
  readonly socketPath: string;
  readonly maxConcurrent: number;
  readonly lanes: readonly LaneStatus[];
  readonly active: readonly RequestRecord[];
  readonly recent: readonly RequestRecord[];
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

export interface ErrorMessage {
  readonly type: 'error';
  readonly id: string | null;
  readonly code: 'bad-message' | 'bad-intent' | 'internal';
  readonly message: string;
}

export type ServerMessage =
  | AckMessage
  | StartedMessage
  | OutputMessage
  | ExitMessage
  | KillResultMessage
  | PongMessage
  | StatusResultMessage
  | ShuttingDownMessage
  | ErrorMessage;

export const encodeServerMessage = (message: ServerMessage): string =>
  `${JSON.stringify(message)}\n`;

export const encodeClientMessage = (message: ClientMessage): string =>
  `${JSON.stringify(message)}\n`;

/** The daemon is a trusted local peer; clients parse its lines without schema checks. */
export const parseServerMessageLine = (line: string): ServerMessage =>
  JSON.parse(line) as ServerMessage;

export const formatTicket = (id: number): string => `cc-${id}`;

/**
 * Incremental NDJSON framing over a byte stream. Buffers bytes (not strings)
 * so multi-byte UTF-8 sequences split across socket chunks decode correctly.
 */
export class LineBuffer {
  #pending: Buffer = Buffer.alloc(0);

  push(data: Uint8Array): string[] {
    this.#pending = Buffer.concat([this.#pending, Buffer.from(data)]);
    const lines: string[] = [];
    let newlineIndex = this.#pending.indexOf(0x0a);
    while (newlineIndex !== -1) {
      const line = this.#pending.subarray(0, newlineIndex).toString('utf8');
      this.#pending = this.#pending.subarray(newlineIndex + 1);
      if (line.trim().length > 0) {
        lines.push(line);
      }
      newlineIndex = this.#pending.indexOf(0x0a);
    }
    return lines;
  }
}
