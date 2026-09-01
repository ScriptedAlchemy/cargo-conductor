import { z } from 'zod';

import type { LaneStatus, RequestRecord, StatusReport } from '../daemon/protocol.js';

export const requestStatusSchema = z.enum([
  'requested',
  'queued',
  'running',
  'done',
  'failed',
  'killed',
]);

export const requestRecordSchema = z
  .object({
    argv: z.array(z.string()),
    createdAtMs: z.number(),
    cwd: z.string(),
    error: z.string().nullable(),
    exitCode: z.number().nullable(),
    finishedAtMs: z.number().nullable(),
    host: z.string().nullable(),
    id: z.number().int(),
    intentJson: z.string().nullable(),
    intentKey: z.string().nullable(),
    laneKey: z.string(),
    outputTail: z.string().nullable(),
    queuedAtMs: z.number().nullable(),
    runMs: z.number().nullable(),
    session: z.string().nullable(),
    signal: z.string().nullable(),
    startedAtMs: z.number().nullable(),
    status: requestStatusSchema,
    targetDir: z.string(),
    ticket: z.string(),
    waitMs: z.number().nullable(),
    workspaceRoot: z.string(),
  })
  .strict() as z.ZodType<RequestRecord>;

export const laneStatusSchema = z
  .object({
    key: z.string(),
    queued: z.number().int(),
    runningTicket: z.string().nullable(),
    targetDir: z.string(),
    workspaceRoot: z.string(),
  })
  .strict() as z.ZodType<LaneStatus>;

export const statusReportSchema = z
  .object({
    active: z.array(requestRecordSchema),
    lanes: z.array(laneStatusSchema),
    maxConcurrent: z.number().int(),
    pid: z.number().int(),
    recent: z.array(requestRecordSchema),
    socketPath: z.string(),
    startedAtMs: z.number(),
  })
  .strict() as z.ZodType<StatusReport>;

export const limitInputSchema = z
  .object({
    limit: z.number().int().min(1).max(500).optional(),
  })
  .strict();

export interface StatusResult {
  readonly active: readonly RequestRecord[];
  readonly daemon: 'running' | 'stopped';
  readonly lanes: readonly LaneStatus[];
  readonly maxConcurrent: number | null;
  readonly operation: 'status';
  readonly pid: number | null;
  readonly recent: readonly RequestRecord[];
  readonly socketPath: string;
  readonly startedAtMs: number | null;
  readonly stateRoot: string;
  readonly summary: string;
}

export interface LogResult {
  readonly daemon: 'running' | 'stopped';
  readonly operation: 'log';
  readonly requests: readonly RequestRecord[];
  readonly summary: string;
}

export interface LastResult {
  readonly daemon: 'running' | 'stopped';
  readonly operation: 'last';
  readonly request: RequestRecord | null;
  readonly summary: string;
}

export interface DaemonResult {
  readonly message: string;
  readonly operation: 'daemon';
  readonly pid: number | null;
  readonly report: StatusReport | null;
  readonly running: boolean;
  readonly socketPath: string;
  readonly subcommand: 'run' | 'start' | 'stop' | 'status';
}

export const statusResultSchema = z
  .object({
    active: z.array(requestRecordSchema),
    daemon: z.enum(['running', 'stopped']),
    lanes: z.array(laneStatusSchema),
    maxConcurrent: z.number().int().nullable(),
    operation: z.literal('status'),
    pid: z.number().int().nullable(),
    recent: z.array(requestRecordSchema),
    socketPath: z.string(),
    startedAtMs: z.number().nullable(),
    stateRoot: z.string(),
    summary: z.string(),
  })
  .strict() as z.ZodType<StatusResult>;

export const logResultSchema = z
  .object({
    daemon: z.enum(['running', 'stopped']),
    operation: z.literal('log'),
    requests: z.array(requestRecordSchema),
    summary: z.string(),
  })
  .strict() as z.ZodType<LogResult>;

export const lastResultSchema = z
  .object({
    daemon: z.enum(['running', 'stopped']),
    operation: z.literal('last'),
    request: requestRecordSchema.nullable(),
    summary: z.string(),
  })
  .strict() as z.ZodType<LastResult>;

export const daemonSubcommandSchema = z.enum(['run', 'start', 'stop', 'status']);

export const daemonInputSchema = z
  .object({
    subcommand: daemonSubcommandSchema,
  })
  .strict();

export const daemonResultSchema = z
  .object({
    message: z.string(),
    operation: z.literal('daemon'),
    pid: z.number().int().nullable(),
    report: statusReportSchema.nullable(),
    running: z.boolean(),
    socketPath: z.string(),
    subcommand: daemonSubcommandSchema,
  })
  .strict() as z.ZodType<DaemonResult>;

export type LimitInput = z.infer<typeof limitInputSchema>;
export type DaemonInput = z.infer<typeof daemonInputSchema>;
