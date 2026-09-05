import { z } from 'zod';

import {
  attachModes,
  awaitCeilingMs,
  requestStatuses,
  statusOutputPreviewBytes,
} from '../daemon/protocol.js';
import type {
  AdmissionHold,
  AttachmentSavingsReport,
  SystemLoadReport,
  KacheGcReport,
  KacheStatusReport,
  KacheStoreLimitReport,
  KacheStorePressureReport,
  LaneStatus,
  PrerequisiteContext,
  RequestRecord,
  StallReport,
  StatusMetrics,
  StatusMetricsHandBack,
  StatusMetricsPhaseSplit,
  StatusMetricsWaitSplit,
  StatusMetricsWindow,
  StatusMetricsWindowBySubcommand,
  StatusReport,
  StatusRow,
} from '../daemon/protocol.js';

const requestStatusSchema = z.enum(requestStatuses);

const attachModeSchema = z.enum(attachModes);
const savedComputeSourceSchema = z.enum(['exact', 'estimate']);
/** `unresponsive`: the socket exists and a process holds it, but it did not answer in time. */
const daemonStatusSchema = z.enum(['running', 'stopped', 'unresponsive']);
export type DaemonStatus = z.infer<typeof daemonStatusSchema>;

const queueContextSchema = z.object({
  aheadTickets: z.array(z.string()),
  headElapsedMs: z.number().nonnegative().optional(),
  headEstimateMs: z.number().nonnegative().optional(),
  headEstimateState: z.literal('overrun').optional(),
  headPhase: z.enum(['compile', 'execute']).optional(),
  headTicket: z.string().optional(),
  position: z.number().int().nonnegative(),
  waitEtaMs: z.number().nonnegative(),
});

const admissionHoldSchema = z.object({
  detail: z.string(),
  reason: z.enum(['memory-hard', 'heavy-profile-cap', 'memory-soft', 'load', 'cpu-stall']),
}) satisfies z.ZodType<AdmissionHold>;

const prerequisiteContextSchema = z.object({
  elapsedMs: z.number().nonnegative().optional(),
  estimateMs: z.number().nonnegative().optional(),
  status: requestStatusSchema,
  ticket: z.string(),
}) satisfies z.ZodType<PrerequisiteContext>;
const stallReportSchema = z.object({
  cpuMs: z.number().nonnegative(),
  idleMs: z.number().nonnegative(),
  since: z.number(),
}) satisfies z.ZodType<StallReport>;

// Daemon-sourced payloads keep zod's default of STRIPPING keys the schema
// does not declare (issue #4). Every field the daemon sends is described
// here, with one deliberate exception: the ledger's row mapper also emits
// `buildFinishedAtMs`, a stamp only the metrics windows summarize, which the
// record schema leaves out. A strict record schema would reject every
// daemon row over it; stripping drops it at the client boundary instead.
export const requestRecordSchema = z.object({
  argv: z.array(z.string()),
  attachMode: attachModeSchema.nullable(),
  savedComputeMs: z.number().int().nonnegative().nullable(),
  savedComputeSource: savedComputeSourceSchema.nullable(),
  savedLatencyMs: z.number().int().nullable(),
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
  /**
   * On-disk full output log (`<stateDir>/tickets/<ticket>.log`); null until
   * the run starts, and for requests that never ran.
   */
  outputPath: z.string().nullable(),
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
  compileEstimateMs: z.number().nonnegative().optional(),
  executeEstimateMs: z.number().nonnegative().optional(),
  phase: z.enum(['compile', 'execute']).optional(),
  estimateState: z.literal('overrun').optional(),
  p90Ms: z.number().nonnegative().optional(),
  execArgv: z.array(z.string()).nullable(),
  /** Tickets this request was submitted `--after`; empty when it had no prerequisites. */
  after: z.array(z.string()),
  queue: queueContextSchema.optional(),
  waitingFor: z.array(prerequisiteContextSchema).optional(),
  delayed: z.boolean().optional(),
  quietMs: z.number().nonnegative().optional(),
  admissionHold: admissionHoldSchema.optional(),
  stall: stallReportSchema.optional(),
  orphaned: z.boolean().optional(),
}) satisfies z.ZodType<RequestRecord>;

const laneStatusSchema = z.object({
  key: z.string(),
  queued: z.number().int(),
  runningTicket: z.string().nullable(),
  executingTickets: z.array(z.string()),
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

/**
 * One row of the status report: the bounded summary contract (#95). The
 * detail record's `outputTail` / `outputTailLive` are not part of it — a
 * status row never carries a tail, settled or live — and a running row's
 * `outputPreview` is capped at `statusOutputPreviewBytes`. The whole tail is
 * the detail contract: `hauler_result` / `hauler_await` answer a
 * `requestRecordSchema` record.
 */
export const statusRowSchema = requestRecordSchema
  .omit({ outputTail: true, outputTailLive: true })
  .extend({
    outputPreview: z.string().max(statusOutputPreviewBytes).nullable(),
  }) satisfies z.ZodType<StatusRow>;

const statusMetricsPhaseSplitSchema = z.object({
  count: z.number().int().nonnegative(),
  compileP50Ms: z.number().nullable(),
  executeP50Ms: z.number().nullable(),
  compileTotalMs: z.number().nonnegative(),
  executeTotalMs: z.number().nonnegative(),
}) satisfies z.ZodType<StatusMetricsPhaseSplit>;

const statusMetricsWindowBySubcommandSchema = z.object({
  subcommand: z.string(),
  profile: z.string(),
  count: z.number().int().nonnegative(),
  p50Ms: z.number().nullable(),
  maxMs: z.number().nullable(),
  // Null when no leader of this population carries the build-finished stamp.
  phases: statusMetricsPhaseSplitSchema.nullable(),
}) satisfies z.ZodType<StatusMetricsWindowBySubcommand>;

const statusMetricsWaitSplitSchema = z.object({
  count: z.number().int().nonnegative(),
  laneBoundMs: z.number().nonnegative(),
  permitBoundMs: z.number().nonnegative(),
  otherMs: z.number().nonnegative(),
  permits: z.number().int().positive().nullable(),
}) satisfies z.ZodType<StatusMetricsWaitSplit>;

const statusMetricsHandBackSchema = z.object({
  leaders: z.number().int().nonnegative(),
  laneReleasedMs: z.number().nonnegative(),
}) satisfies z.ZodType<StatusMetricsHandBack>;

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
  runTotalMs: z.number().nonnegative(),
  waitTotalMs: z.number().nonnegative(),
  waitSplit: statusMetricsWaitSplitSchema,
  handBack: statusMetricsHandBackSchema,
}) satisfies z.ZodType<StatusMetricsWindow>;

const statusMetricsSchema = z.object({
  attach_mode: frequencyMetricSchema,
  attach_rejections: frequencyMetricSchema,
  cargo_run_ms: histogramMetricSchema,
  cargo_run_ms_by_kind: z.record(z.string(), histogramMetricSchema),
  job_outcome: frequencyMetricSchema,
  windows: z.array(statusMetricsWindowSchema),
  wait_ms_summary: z.object({
    count: z.number().int().nonnegative(),
    max: z.number().nullable(),
    min: z.number().nullable(),
    quantiles: z.array(z.tuple([z.number(), z.number().nullable()])),
    sum: z.number(),
  }),
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
  memFullAvg10: z.number().nonnegative().optional(),
  memSomeAvg10: z.number().nonnegative().optional(),
  memAvailableBytes: z.number().int().nonnegative().optional(),
  memPressureLevel: z.union([z.literal(1), z.literal(2), z.literal(4)]).optional(),
  memClamp: z.enum(['none', 'soft', 'hard']),
  // Absent when the heavy-leader cap is disabled.
  heavy: z
    .object({
      capActive: z.boolean(),
      maxConcurrent: z.number().int().positive(),
      running: z.number().int().nonnegative(),
    })
    .optional(),
}) satisfies z.ZodType<SystemLoadReport>;

const kacheStoreLimitSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('known'),
    bytes: z.number().nonnegative(),
    source: z.string(),
  }),
  z.object({
    kind: z.literal('unknown'),
    reason: z.enum(['config-missing', 'not-configured', 'unparsable', 'store-mismatch']),
    detail: z.string(),
  }),
]) satisfies z.ZodType<KacheStoreLimitReport>;

const kacheGcSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('unavailable'),
    reason: z.enum(['missing', 'unparsable']),
  }),
  z.object({
    kind: z.literal('ran'),
    lastRunAtMs: z.number(),
    durationMs: z.number().nonnegative().nullable(),
    entriesEvicted: z.number().int().nonnegative().nullable(),
    bytesFreed: z.number().nonnegative().nullable(),
    diskBytesReclaimed: z.number().nonnegative().nullable(),
    blobsRemoved: z.number().int().nonnegative().nullable(),
    declined: z.boolean(),
    entriesPinned: z.number().int().nonnegative().nullable(),
    entriesUnreclaimable: z.number().int().nonnegative().nullable(),
    evictionErrors: z.number().int().nonnegative().nullable(),
    evictionErrorSample: z.string().nullable(),
  }),
]) satisfies z.ZodType<KacheGcReport>;

const kacheStorePressureSchema = z.object({
  storeBytes: z.number().nonnegative().nullable(),
  limit: kacheStoreLimitSchema,
  gc: kacheGcSchema,
  keyTiming: z
    .object({
      count: z.number().int().nonnegative(),
      meanMs: z.number().nonnegative(),
      p95Ms: z.number().nonnegative(),
    })
    .nullable(),
}) satisfies z.ZodType<KacheStorePressureReport>;

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
  pressure: kacheStorePressureSchema,
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

/** The daemon's `status-result` report: every section is present on every reply. */
export const statusReportSchema = z.object({
  active: z.array(statusRowSchema),
  // Null when kache is not configured or its index has not been read yet.
  kache: kacheStatusSchema.nullable(),
  savings: savingsSchema,
  system: systemLoadSchema,
  lanes: z.array(laneStatusSchema),
  maxConcurrent: z.number().int(),
  metrics: statusMetricsSchema,
  pid: z.number().int(),
  recent: z.array(statusRowSchema),
  socketPath: z.string(),
  startedAtMs: z.number(),
  version: z.string(),
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

/**
 * The `hauler status` document. The daemon-only sections (`kache`, `savings`,
 * `system`, `metrics`) come from the report of a daemon the probe reached;
 * a `stopped` or `unresponsive` daemon yields none of them.
 */
export interface StatusResult {
  /** Bounded summary rows (`statusRowSchema`); read a ticket's tail with `result`. */
  readonly active: readonly StatusRow[];
  readonly daemon: DaemonStatus;
  readonly kache?: KacheStatusReport | null;
  readonly savings?: AttachmentSavingsReport;
  readonly system?: SystemLoadReport;
  readonly lanes: readonly LaneStatus[];
  readonly maxConcurrent: number | null;
  readonly metrics?: StatusMetrics;
  readonly operation: 'status';
  readonly pid: number | null;
  readonly recent: readonly StatusRow[];
  readonly socketPath: string;
  readonly startedAtMs: number | null;
  readonly stateRoot: string;
  readonly summary: string;
}

export interface LogResult {
  readonly daemon: DaemonStatus;
  readonly operation: 'log';
  /** Bounded summary rows, as for status; `result` reads a ticket's tail. */
  readonly requests: readonly StatusRow[];
  readonly summary: string;
}

export interface LastResult {
  readonly daemon: DaemonStatus;
  readonly operation: 'last';
  readonly request: RequestRecord | null;
  readonly summary: string;
}

export interface DaemonResult {
  readonly message: string;
  readonly operation: 'daemon';
  readonly pid: number | null;
  /**
   * `restart`, and a `start` that had to replace a daemon of another version:
   * the pid that was serving before, null when none was.
   */
  readonly previousPid?: number | null;
  readonly report: StatusReport | null;
  readonly running: boolean;
  readonly socketPath: string;
  readonly subcommand: 'run' | 'start' | 'stop' | 'status' | 'restart';
}

export const statusResultSchema = z
  .object({
    active: z.array(statusRowSchema),
    daemon: daemonStatusSchema,
    kache: kacheStatusSchema.nullable().optional(),
    savings: savingsSchema.optional(),
    system: systemLoadSchema.optional(),
    lanes: z.array(laneStatusSchema),
    maxConcurrent: z.number().int().nullable(),
    metrics: statusMetricsSchema.optional(),
    operation: z.literal('status'),
    pid: z.number().int().nullable(),
    recent: z.array(statusRowSchema),
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
    requests: z.array(statusRowSchema),
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

const daemonSubcommandSchema = z.enum(['run', 'start', 'stop', 'status', 'restart']);

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
    previousPid: z.number().int().nullable().optional(),
    report: statusReportSchema.nullable(),
    running: z.boolean(),
    socketPath: z.string(),
    subcommand: daemonSubcommandSchema,
  })
  .strict() satisfies z.ZodType<DaemonResult>;

/**
 * One `await` call waits up to the daemon's own ceiling (`awaitCeilingMs`,
 * 2 h): the rendered routes declare a matching `config.render.maxElapsedMs`
 * (agent-bundle#454), so the wire is the only bound. Callers wanting longer
 * call again.
 */
export const awaitMaxWaitMessage = `maxWaitMs is capped at ${awaitCeilingMs} ms (2 h) per call — the daemon's await ceiling; call await again to keep waiting`;

export const ticketInputSchema = z
  .object({
    ticket: z.string().min(1),
    maxWaitMs: z.number().int().min(0).max(awaitCeilingMs, { message: awaitMaxWaitMessage }).optional(),
  })
  .strict();

/**
 * `hauler_result` alone takes `full`: the whole on-disk output log as the
 * document body. `hauler_await` keeps `ticketInputSchema` — a wait that ends
 * in a full log would blow the rendered-route budget for nothing.
 */
export const resultInputSchema = z
  .object({
    ticket: z.string().min(1),
    full: z
      .boolean()
      .optional()
      .describe('Render the whole on-disk output log instead of the stored tail'),
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

export const killResultSchema = z
  .object({
    killed: z.boolean(),
    operation: z.literal('kill'),
    request: requestRecordSchema.nullable(),
    summary: z.string(),
    ticket: z.string(),
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
    after: z
      .array(z.string().min(1))
      .max(50)
      .optional()
      .describe(
        'Tickets (cc-N) that must finish before this request starts; it fails if any of them fails or is killed',
      ),
  })
  .strict();

/** Where a just-submitted request landed in its lane, from the daemon's acknowledgement. */
export const requestQueueSchema = z
  .object({
    ahead: z.array(z.string()),
    position: z.number().int().nonnegative(),
    waitEtaMs: z.number().nonnegative().optional(),
  })
  .strict();

/** The conversation a ticket was requested from, when the host placed the call in one (`request.lineage`). */
export const ticketLineageSchema = z
  .object({
    conversation: z.string(),
    depth: z.number().int().nonnegative(),
    parent: z.string().optional(),
    // Mirrors the runtime's AgentLineageResolution; `confirmed` is a registry
    // edge the host itself named (Claude's Agent PostToolUse, agent-bundle#486),
    // `transcript` one read back from the host's transcript (agent-bundle#457).
    resolution: z.enum(['native', 'registry', 'confirmed', 'transcript', 'inferred']),
    root: z.string(),
  })
  .strict();

export const ticketAttributionSchema = z
  .object({
    host: z.string(),
    lineage: ticketLineageSchema.nullable(),
    session: z.string().nullable(),
  })
  .strict();

export const requestResultSchema = z
  .object({
    attribution: ticketAttributionSchema,
    operation: z.literal('request'),
    queue: requestQueueSchema.optional(),
    summary: z.string(),
    ticket: z.string().nullable(),
    waitingFor: z.array(z.string()).optional(),
  })
  .strict();

export interface AwaitResult {
  readonly operation: 'await';
  readonly request: RequestRecord | null;
  readonly summary: string;
  readonly ticket: string;
  readonly timedOut: boolean;
}

export interface KillResult {
  /** True when the daemon accepted the kill; false when the ticket was unknown or already finished. */
  readonly killed: boolean;
  readonly operation: 'kill';
  /** The ticket right after the request was accepted; it settles as `killed` once the process is gone. */
  readonly request: RequestRecord | null;
  readonly summary: string;
  readonly ticket: string;
}

export interface ResultFetchResult {
  readonly operation: 'result';
  readonly request: RequestRecord | null;
  readonly summary: string;
  readonly ticket: string;
}

export type TicketLineage = z.infer<typeof ticketLineageSchema>;
export type TicketAttribution = z.infer<typeof ticketAttributionSchema>;
export type RequestQueue = z.infer<typeof requestQueueSchema>;

export interface RequestSubmitResult {
  readonly attribution: TicketAttribution;
  readonly operation: 'request';
  /** Lane placement at submission; absent when the request attached to a run or the lane was idle. */
  readonly queue?: RequestQueue;
  readonly summary: string;
  readonly ticket: string | null;
  /** Prerequisites (`after`) still unsettled at submission. */
  readonly waitingFor?: readonly string[];
}

export type LimitInput = z.infer<typeof limitInputSchema>;
export type StatusInput = z.infer<typeof statusInputSchema>;
export type DaemonInput = z.infer<typeof daemonInputSchema>;
export type TicketInput = z.infer<typeof ticketInputSchema>;
export type ResultInput = z.infer<typeof resultInputSchema>;
export type RequestInput = z.infer<typeof requestInputSchema>;
