import { z } from 'zod';

import { awaitCeilingMs } from '../daemon/protocol.js';
import type {
  AttachmentSavingsReport,
  SystemLoadReport,
  KacheStatusReport,
  LaneStatus,
  RequestRecord,
  StatusMetrics,
  StatusReport,
} from '../daemon/protocol.js';

const requestStatusSchema = z.enum([
  'requested',
  'queued',
  'running',
  'done',
  'failed',
  'killed',
  'denied',
  'passthrough',
]);

const attachModeSchema = z.enum(['identity', 'coverage', 'batch']);
const savedComputeSourceSchema = z.enum(['exact', 'estimate']);
const daemonStatusSchema = z.enum(['running', 'stopped']);

// Daemon-sourced payloads deliberately STRIP unknown keys instead of
// rejecting them (issue #4): plugin snapshots outlive daemon upgrades, and a
// strict schema here turns every additive daemon field into a breaking
// change for still-running MCP servers from older installs.
export const requestRecordSchema = z.object({
  argv: z.array(z.string()),
  attachMode: attachModeSchema.nullable(),
  savedComputeMs: z.number().int().nonnegative().nullable().optional(),
  savedComputeSource: savedComputeSourceSchema.nullable().optional(),
  savedLatencyMs: z.number().int().nullable().optional(),
  attachedTo: z.string().nullable(),
  createdAtMs: z.number(),
  cwd: z.string(),
  diagnostics: z.array(z.string()).nullable(),
  error: z.string().nullable(),
  errorCount: z.number().int().nonnegative().nullable(),
  exitCode: z.number().nullable(),
  finishedAtMs: z.number().nullable(),
  host: z.string().nullable(),
  id: z.number().int(),
  intentJson: z.string().nullable(),
  intentKey: z.string().nullable(),
  laneKey: z.string(),
  outputTail: z.string().nullable(),
  /** True when outputTail is a live in-progress snapshot, not the settled tail. */
  outputTailLive: z.boolean().optional(),
  queuedAtMs: z.number().nullable(),
  runMs: z.number().nullable(),
  session: z.string().nullable(),
  signal: z.string().nullable(),
  startedAtMs: z.number().nullable(),
  status: requestStatusSchema,
  targetDir: z.string(),
  ticket: z.string(),
  waitMs: z.number().nullable(),
  warningCount: z.number().int().nonnegative().nullable(),
  workspaceRoot: z.string(),
  background: z.boolean(),
  holdStop: z.boolean(),
  estimateMs: z.number().nullable(),
  execArgv: z.array(z.string()).nullable(),
}) satisfies z.ZodType<RequestRecord>;

const laneStatusSchema = z.object({
  key: z.string(),
  queued: z.number().int(),
  runningTicket: z.string().nullable(),
  targetDir: z.string(),
  workspaceRoot: z.string(),
}) satisfies z.ZodType<LaneStatus>;

const frequencyMetricSchema = z.record(z.string(), z.number().int().nonnegative());
const histogramMetricSchema = z.object({
  buckets: z.array(z.tuple([z.number().nullable(), z.number().int().nonnegative()])),
  count: z.number().int().nonnegative(),
  max: z.number().nullable(),
  min: z.number().nullable(),
  sum: z.number(),
});

const statusMetricsWindowBySubcommandSchema = z.object({
  subcommand: z.string(),
  profile: z.string().optional(),
  count: z.number().int().nonnegative(),
  p50Ms: z.number().nullable(),
  maxMs: z.number().nullable(),
});

const statusMetricsWindowSchema = z.object({
  id: z.enum(['hour', 'day', 'all']),
  count: z.number().int().nonnegative(),
  done: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  killed: z.number().int().nonnegative(),
  runP50Ms: z.number().nullable(),
  runP95Ms: z.number().nullable(),
  runMeanMs: z.number().nullable(),
  waitP50Ms: z.number().nullable(),
  waitP95Ms: z.number().nullable(),
  bySubcommand: z.array(statusMetricsWindowBySubcommandSchema),
});

const statusMetricsSchema = z.object({
  attach_mode: frequencyMetricSchema,
  cargo_run_ms: histogramMetricSchema,
  cargo_run_ms_by_kind: z.record(z.string(), histogramMetricSchema).optional(),
  job_outcome: frequencyMetricSchema,
  windows: z.array(statusMetricsWindowSchema).optional(),
  wait_ms_summary: z
    .object({
      count: z.number().int().nonnegative(),
      max: z.number().nullable(),
      min: z.number().nullable(),
      quantiles: z.array(z.tuple([z.number(), z.number().nullable()])),
      sum: z.number(),
    })
    .optional(),
}) satisfies z.ZodType<StatusMetrics>;

const systemLoadSchema = z.object({
  loadAvg1: z.number().nonnegative(),
  cores: z.number().int().positive(),
  clampThresholdPerCore: z.number().positive().nullable(),
  // Linux-only /proc deltas; absent where no honest sample exists.
  ioWaitPercent: z.number().min(0).max(100).optional(),
  disks: z
    .array(
      z.object({
        device: z.string(),
        utilPercent: z.number().min(0).max(100),
      }),
    )
    .optional(),
}) satisfies z.ZodType<SystemLoadReport>;

const kacheStatusSchema = z.object({
  available: z.boolean(),
  distinctCrates: z.number().int().nonnegative(),
  entryCount: z.number().int().nonnegative(),
  eventsFreshMs: z.number().nonnegative().nullable(),
  indexSizeBytes: z.number().int().nonnegative(),
  recentHeartbeatRoots: z.array(z.object({
    count: z.number().int().nonnegative(),
    root: z.string(),
  })),
  topCrates: z.array(z.object({
    crate: z.string(),
    ms: z.number().nonnegative(),
    profile: z.string(),
  })),
}) satisfies z.ZodType<KacheStatusReport>;

const savingsModeSchema = z.object({
  mode: attachModeSchema,
  ridersServed: z.number().int().nonnegative(),
  savedComputeMs: z.number().int().nonnegative(),
  savedComputeExactMs: z.number().int().nonnegative(),
  savedComputeEstimatedMs: z.number().int().nonnegative(),
  savedLatencyMs: z.number().int(),
  negativeLatencyRiders: z.number().int().nonnegative(),
});

const savingsTotalsSchema = z.object({
  ridersServed: z.number().int().nonnegative(),
  savedComputeMs: z.number().int().nonnegative(),
  savedComputeExactMs: z.number().int().nonnegative(),
  savedComputeEstimatedMs: z.number().int().nonnegative(),
  savedLatencyMs: z.number().int(),
  negativeLatencyRiders: z.number().int().nonnegative(),
});

const savingsSchema = z.object({
  byMode: z.array(savingsModeSchema),
  totals: savingsTotalsSchema,
});

export const statusReportSchema = z.object({
  active: z.array(requestRecordSchema),
  kache: kacheStatusSchema.nullable().optional(),
  savings: savingsSchema.optional(),
  system: systemLoadSchema.optional(),
  lanes: z.array(laneStatusSchema),
  maxConcurrent: z.number().int(),
  metrics: statusMetricsSchema.optional(),
  pid: z.number().int(),
  recent: z.array(requestRecordSchema),
  socketPath: z.string(),
  startedAtMs: z.number(),
}) satisfies z.ZodType<StatusReport>;


export const limitInputSchema = z
  .object({
    limit: z.number().int().min(1).max(500).optional(),
  })
  .strict();

export const statusInputSchema = z
  .object({
    limit: z.number().int().min(1).max(500).optional(),
    cwd: z.string().min(1).optional(),
    session: z.string().min(1).optional(),
    laneKey: z.string().min(1).optional(),
    tickets: z.array(z.string().min(1)).max(100).optional(),
    statuses: z.array(requestStatusSchema).max(8).optional(),
    commandContains: z.string().min(1).optional(),
  })
  .strict();

export interface StatusResult {
  readonly active: readonly RequestRecord[];
  readonly daemon: 'running' | 'stopped';
  readonly kache?: KacheStatusReport | null;
  readonly savings?: AttachmentSavingsReport;
  readonly system?: SystemLoadReport;
  readonly lanes: readonly LaneStatus[];
  readonly maxConcurrent: number | null;
  readonly metrics?: StatusMetrics;
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
    daemon: daemonStatusSchema,
    kache: kacheStatusSchema.nullable().optional(),
    savings: savingsSchema.optional(),
    system: systemLoadSchema.optional(),
    lanes: z.array(laneStatusSchema),
    maxConcurrent: z.number().int().nullable(),
    metrics: statusMetricsSchema.optional(),
    operation: z.literal('status'),
    pid: z.number().int().nullable(),
    recent: z.array(requestRecordSchema),
    socketPath: z.string(),
    startedAtMs: z.number().nullable(),
    stateRoot: z.string(),
    summary: z.string(),
  })
  .strict() satisfies z.ZodType<StatusResult>;

export const logResultSchema = z
  .object({
    daemon: daemonStatusSchema,
    operation: z.literal('log'),
    requests: z.array(requestRecordSchema),
    summary: z.string(),
  })
  .strict() satisfies z.ZodType<LogResult>;

export const lastResultSchema = z
  .object({
    daemon: daemonStatusSchema,
    operation: z.literal('last'),
    request: requestRecordSchema.nullable(),
    summary: z.string(),
  })
  .strict() satisfies z.ZodType<LastResult>;

const daemonSubcommandSchema = z.enum(['run', 'start', 'stop', 'status']);

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
  .strict() satisfies z.ZodType<DaemonResult>;

/** Await ceiling (2h): agent build queues here routinely exceed 15 minutes. */
export const awaitMaxWaitMs = awaitCeilingMs;

export const ticketInputSchema = z
  .object({
    ticket: z.string().min(1),
    maxWaitMs: z.number().int().min(0).max(awaitMaxWaitMs).optional(),
  })
  .strict();

export const awaitResultSchema = z
  .object({
    operation: z.literal('await'),
    request: requestRecordSchema.nullable(),
    summary: z.string(),
    ticket: z.string(),
    timedOut: z.boolean(),
  })
  .strict();

export const resultFetchResultSchema = z
  .object({
    operation: z.literal('result'),
    request: requestRecordSchema.nullable(),
    summary: z.string(),
    ticket: z.string(),
  })
  .strict();

export const requestInputSchema = z
  .object({
    argv: z.array(z.string()).min(1),
    cwd: z.string().min(1),
    session: z.string().optional(),
    host: z.string().optional(),
  })
  .strict();

export const requestResultSchema = z
  .object({
    operation: z.literal('request'),
    summary: z.string(),
    ticket: z.string().nullable(),
  })
  .strict();

export interface AwaitResult {
  readonly operation: 'await';
  readonly request: RequestRecord | null;
  readonly summary: string;
  readonly ticket: string;
  readonly timedOut: boolean;
}

export interface ResultFetchResult {
  readonly operation: 'result';
  readonly request: RequestRecord | null;
  readonly summary: string;
  readonly ticket: string;
}

export interface RequestSubmitResult {
  readonly operation: 'request';
  readonly summary: string;
  readonly ticket: string | null;
}

export type LimitInput = z.infer<typeof limitInputSchema>;
export type StatusInput = z.infer<typeof statusInputSchema>;
export type DaemonInput = z.infer<typeof daemonInputSchema>;
export type TicketInput = z.infer<typeof ticketInputSchema>;
export type RequestInput = z.infer<typeof requestInputSchema>;
