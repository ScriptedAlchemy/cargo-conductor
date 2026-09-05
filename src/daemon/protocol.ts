import { z } from 'zod';

export { LineBuffer } from '../lib/ndjson.js';

/**
 * Wire protocol for the hauler daemon: one JSON document per line
 * (NDJSON) in each direction over the daemon's unix socket. This module is
 * the shared vocabulary between the daemon, the control/exec clients, and
 * the ledger, so it must not import from the other daemon modules.
 */

/** Every status a request passes through, in lifecycle order. One list feeds the type, the schema, and the SQL filters. */
export const requestStatuses = [
  'requested',
  'queued',
  'running',
  'done',
  'failed',
  'killed',
  'denied',
  'passthrough',
] as const;
export type RequestStatus = (typeof requestStatuses)[number];

/** Statuses of a request the daemon still owns. */
export const activeStatuses = ['requested', 'queued', 'running'] as const;
/** Terminal statuses a request can end in after running. */
export const finishedStatuses = ['done', 'failed', 'killed'] as const;
export type FinishedStatus = (typeof finishedStatuses)[number];
/** Every terminal status, including the ones that never ran. */
export const terminalStatuses = ['done', 'failed', 'killed', 'denied', 'passthrough'] as const;
export type TerminalStatus = (typeof terminalStatuses)[number];

/**
 * How an attached request rides its leader (see daemon/coverage.ts):
 * 'identity' mirrors everything, 'coverage' rides a stronger in-flight run,
 * 'batch' was composed into a merged invocation. Coverage and compile-batch
 * attachments requeue when the leader fails (unless their scope was proven);
 * a folded test/nextest participant mirrors the composite's failure only
 * when it named every package the composite ran, and requeues otherwise.
 */
export const attachModes = ['identity', 'coverage', 'batch'] as const;
export type AttachMode = (typeof attachModes)[number];

/**
 * Why a request could not ride an in-flight leader in its lane (see
 * daemon/coverage.ts). Listed in evaluation order, which is also how close
 * the pair came to attaching: `subcommand` is a pair that never shares,
 * `leader-build-finished` is a compatible coverage rider that arrived after
 * the leader's compile had already ended. `hauler status` reports one count
 * per gate under `metrics.attach_rejections`, taken from the nearest miss
 * among the lane's leaders for each request that did not attach.
 */
export const attachRejectionGates = [
  'shell-wrapped',
  'subcommand',
  'opaque-arguments',
  'passthrough',
  'compile-surface',
  'packages',
  'targets',
  'channels',
  'leader-build-finished',
] as const;
export type AttachRejectionGate = (typeof attachRejectionGates)[number];

/** Provenance of a runtime estimate: measured (`ewma`), kache priors, or a cold-start default. */
export type EstimateSource = 'ewma' | 'kache' | 'default';
export type SavedComputeSource = 'exact' | 'estimate';

/**
 * Live phase of a running cargo: `compile` until Cargo's `Finished` line,
 * `execute` after it. Omitted when the daemon cannot see the split (an
 * execution subcommand with overlap execution disabled).
 */
export type RunPhase = 'compile' | 'execute';

/**
 * A running head that is past `stallEstimateFactor` × its estimate but still
 * producing output or CPU. Distinct from `stall`: agents may background this
 * rather than kill it.
 */
export type EstimateState = 'overrun';

/** Live, lane-local context for a queued request. Never persisted to the ledger. */
export interface QueueContext {
  /** Number of running or queued leaders expected to run before this request. */
  readonly position: number;
  readonly aheadTickets: readonly string[];
  /** The currently running lane head, when the lane is occupied. */
  readonly headTicket?: string;
  readonly headElapsedMs?: number;
  readonly headEstimateMs?: number;
  /** Phase of the running head once it has a compile/execute split. */
  readonly headPhase?: RunPhase;
  /** `overrun` when the head is past its estimate but alive, so `waitEtaMs` rests on its history p90. */
  readonly headEstimateState?: EstimateState;
  /**
   * Lane time still ahead of this request: each ticket's remaining compile
   * (plus execute unless overlap hands the lane back), with an overrun-but-alive
   * head re-estimated from its history p90, clamped at zero.
   */
  readonly waitEtaMs: number;
}

/**
 * Live view of one prerequisite (`--after`) a queued request is still waiting
 * on. Present only while the dependent is blocked; never persisted.
 */
export interface PrerequisiteContext {
  readonly ticket: string;
  readonly status: RequestStatus;
  /** Milliseconds the prerequisite has been running, once it started. */
  readonly elapsedMs?: number;
  readonly estimateMs?: number;
}

/** Which admission arm is holding a lane head back from its permit. */
export type AdmissionDeferReason =
  | 'memory-hard'
  | 'heavy-profile-cap'
  | 'memory-soft'
  | 'load'
  | 'cpu-stall';

/** Live admission hold on a lane head that has left the queue but not yet started. */
export interface AdmissionHold {
  readonly reason: AdmissionDeferReason;
  /** Human-readable cause, e.g. "1 heavy build already running and MemAvailable 11.2 GiB < 16 GiB". */
  readonly detail: string;
}

/**
 * Live stall verdict on a running leader (and, by extension, its riders):
 * the run overran its estimate, its process tree burned no CPU for `idleMs`,
 * and it emitted no output in that window. Never persisted to the ledger.
 */
export interface StallReport {
  /** When the leader was first flagged stalled. */
  readonly since: number;
  /** Milliseconds since the process tree's CPU time last changed. */
  readonly idleMs: number;
  /** Total CPU time of the process tree at the last sample, in milliseconds. */
  readonly cpuMs: number;
}

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
  /**
   * When cargo reported the build finished on a leader that goes on to run
   * tests, benches, or a program; null before that, for pure compiles, and
   * on rows older than the column. Riders share their leader's value.
   */
  readonly buildFinishedAtMs?: number | null;
  readonly waitMs: number | null;
  readonly runMs: number | null;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly outputTail: string | null;
  /**
   * True when `outputTail` is a live snapshot of an in-progress run's
   * captured output rather than the final tail the ledger stores at
   * settlement. Lets agents polling a slow build see progress instead of
   * staying blind until the end.
   */
  readonly outputTailLive?: boolean;
  /**
   * Full combined stdout+stderr of the run on disk
   * (`<stateDir>/tickets/<ticket>.log`), bounded by
   * `CARGO_HAULER_TICKET_LOG_MAX_BYTES`. A leader's own file; for an attached
   * follower, the leader's file it shared. Null until the run starts, and
   * for requests that never ran.
   */
  readonly outputPath: string | null;
  readonly error: string | null;
  readonly errorCount: number | null;
  readonly warningCount: number | null;
  readonly diagnostics: readonly string[] | null;
  /** Leader ticket when this request was served by attaching to another run. */
  readonly attachedTo: string | null;
  readonly attachMode: AttachMode | null;
  /**
   * Counterfactual machine time this follower did not burn because it rode a
   * leader. Null means "no served follower savings recorded" (leaders,
   * requeued riders, detached/killed before service).
   */
  readonly savedComputeMs: number | null;
  /**
   * Provenance of `savedComputeMs`: `exact` means the leader's measured run
   * time anchored the value; `estimate` means a follower estimate supplied it.
   */
  readonly savedComputeSource: SavedComputeSource | null;
  /**
   * Counterfactual latency savings for the follower:
   * `estimateMs - (settledAtMs - max(createdAtMs, leaderStartedAtMs))`: time
   * queued behind a leader that had not started yet is lane wait the rider
   * would have paid alone as well. Negative values are expected and honest:
   * they mean the rider rode longer than its own solo run would have taken.
   */
  readonly savedLatencyMs: number | null;
  /** The invocation actually spawned (demux flag, batch-folded -p packages); null until run. */
  readonly execArgv: readonly string[] | null;
  readonly background: boolean;
  readonly holdStop: boolean;
  readonly estimateMs: number | null;
  /**
   * Compile-phase estimate (started → build-finished) of the run this request
   * leads or rides; equals that run's `estimateMs` when there is no split.
   */
  readonly compileEstimateMs?: number;
  /** Execution-phase estimate (build-finished → exit) of that run; omitted for compile-only subcommands. */
  readonly executeEstimateMs?: number;
  /** Current phase of a running leader (or the leader this request rides). */
  readonly phase?: RunPhase;
  /** Live overrun flag; never persisted. Absent while the estimate still holds or the head is stalled. */
  readonly estimateState?: EstimateState;
  /** Intent-history p90 used to re-estimate remaining time once `estimateState` is `overrun`. */
  readonly p90Ms?: number;
  /** Tickets this request was submitted `--after`: it stays queued until every one has settled. */
  readonly after: readonly string[];
  /** Live queue context, present only while this request is queued. */
  readonly queue?: QueueContext;
  /** Prerequisites still unsettled, present only while this request is blocked on them. */
  readonly waitingFor?: readonly PrerequisiteContext[];
  /** True once queued wait exceeds max(2 × own estimate, 10 minutes). */
  readonly delayed?: boolean;
  /** Milliseconds since the running leader last emitted output, once over five minutes. */
  readonly quietMs?: number;
  /** Present while the (leader) request is held by an admission arm; never persisted. */
  readonly admissionHold?: AdmissionHold;
  /** Present while the running leader (or the leader this request rides) looks stalled. */
  readonly stall?: StallReport;
  /** True once the connection that submitted this running request has disconnected. */
  readonly orphaned?: boolean;
}

/**
 * Bytes of a running ticket's live output a status row carries (#95). The
 * bound is part of the status contract (`statusRowSchema`), independent of
 * `outputTailBytes` — the 16 KiB a `RequestRecord` tail may hold — so a
 * status document's size follows the number of rows, not what each printed.
 */
export const statusOutputPreviewBytes = 512;

/** Lines of a running ticket's live output a status row carries. */
export const statusOutputPreviewLines = 8;

/**
 * One request as the status report lists it: the bounded summary contract.
 * A status row never carries an output tail — not the settled 16 KiB tail
 * the ledger stores, not the live in-memory tail of a running job. A running
 * row carries `outputPreview`, the last `statusOutputPreviewLines` lines
 * (at most `statusOutputPreviewBytes`) of its live output, cut at a line
 * boundary; every other row has `null`. The whole tail is the detail
 * contract: `result` / `await` answer a `RequestRecord` (#95).
 */
export interface StatusRow extends TicketSummary {
  readonly outputPreview: string | null;
}

/**
 * A request without its output tail: what every listing surface (status
 * rows, log rows, lane boards) reads. A `RequestRecord` is one, so detail
 * readers can pass their record to the same components.
 */
export type TicketSummary = Omit<RequestRecord, 'outputTail' | 'outputTailLive'>;

/** The status row for a record: the tail fields dropped, the preview supplied by the caller. */
export const toStatusRow = (record: RequestRecord, outputPreview: string | null = null): StatusRow => {
  const { outputTail: _outputTail, outputTailLive: _outputTailLive, ...summary } = record;
  return { ...summary, outputPreview };
};

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
  /** Run the child with stderr on the stdout pipe so the caller's `2>&1` keeps write order. */
  mergeStderr: z.boolean().optional(),
  /** Tickets that must settle before this request may start; a failed or killed one fails it. */
  after: z.array(z.string().min(1)).optional(),
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
  /**
   * The requesting client's release version. The daemon refuses a shutdown
   * from a client older than itself, or from one that sends no version
   * (every client before this field): replacement is directional, a newer
   * install replaces an older daemon and never the reverse.
   */
  version: z.string().min(1).optional(),
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
  /**
   * Leaders past their build that still execute (tests, benches, a program)
   * in this lane while the next compile may already run; empty when none do.
   */
  readonly executingTickets: readonly string[];
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
  readonly cargo_run_ms_by_kind: Readonly<Record<string, HistogramMetricSnapshot>>;
  readonly job_outcome: Readonly<Record<string, number>>;
  readonly attach_mode: Readonly<Record<string, number>>;
  /**
   * Requests that found in-flight leaders in their lane but attached to none,
   * counted once each under the gate of their nearest miss
   * (`AttachRejectionGate`).
   */
  readonly attach_rejections: Readonly<Record<string, number>>;
  readonly windows: readonly StatusMetricsWindow[];
  readonly wait_ms_summary: {
    readonly count: number;
    readonly min: number | null;
    readonly max: number | null;
    readonly sum: number;
    readonly quantiles: ReadonlyArray<readonly [number, number | null]>;
  };
}

export type StatusMetricsWindowId = 'hour' | 'day' | 'all';

/**
 * Compile versus execution time of the leaders whose `buildFinishedAtMs`
 * stamp splits the two (test, nextest, bench, and run leaders).
 */
export interface StatusMetricsPhaseSplit {
  /** Leaders with a build-finished stamp; pure compiles never have one. */
  readonly count: number;
  readonly compileP50Ms: number | null;
  readonly executeP50Ms: number | null;
  readonly compileTotalMs: number;
  readonly executeTotalMs: number;
}

export interface StatusMetricsWindowBySubcommand {
  readonly subcommand: string;
  /** The intent's profile, or cargo's default for the subcommand when the argv named none. */
  readonly profile: string;
  readonly count: number;
  readonly p50Ms: number | null;
  readonly maxMs: number | null;
  /** Null when no leader of this population carries the build-finished stamp (pure compiles never do). */
  readonly phases: StatusMetricsPhaseSplit | null;
}

/**
 * Where leaders' queue wait went (#92). Lane-bound: a leader in the same
 * lane was still compiling (before its build-finished or finish stamp).
 * Permit-bound: every admission permit was held by a running leader while
 * no same-lane head compiled. Other: admission holds, `--after`
 * prerequisites, and scheduling latency.
 */
export interface StatusMetricsWaitSplit {
  /** Leaders in the window whose queued and started stamps bound a wait. */
  readonly count: number;
  readonly laneBoundMs: number;
  readonly permitBoundMs: number;
  readonly otherMs: number;
  /**
   * Admission permits the permit-bound classification assumed: the daemon's
   * current `maxConcurrent`, which earlier rows may not have run under. Null
   * when the ledger was opened without one, in which case nothing is
   * permit-bound and that share is reported as other.
   */
  readonly permits: number | null;
}

/** Lane time the execution-phase hand-back gave to the next compile. */
export interface StatusMetricsHandBack {
  /** Leaders that handed their lane back before settling. */
  readonly leaders: number;
  /** Sum of those leaders' execution phases: lane time another compile could use. */
  readonly laneReleasedMs: number;
}

export interface StatusMetricsWindow {
  readonly id: StatusMetricsWindowId;
  readonly count: number;
  readonly done: number;
  readonly failed: number;
  readonly killed: number;
  readonly runP50Ms: number | null;
  readonly runP95Ms: number | null;
  readonly runMeanMs: number | null;
  readonly waitP50Ms: number | null;
  readonly waitP95Ms: number | null;
  readonly bySubcommand: readonly StatusMetricsWindowBySubcommand[];
  /** Sum of leader run time in the window. */
  readonly runTotalMs: number;
  /** Sum of leader queue wait in the window. */
  readonly waitTotalMs: number;
  readonly waitSplit: StatusMetricsWaitSplit;
  readonly handBack: StatusMetricsHandBack;
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

/**
 * kache's configured store budget (`[cache] local_max_size`, or the
 * `KACHE_MAX_SIZE` environment override). Unknown is reported with why, never
 * guessed: kache applies a disk-share default of its own when neither is set.
 */
export type KacheStoreLimitReport =
  | {
      readonly kind: 'known';
      readonly bytes: number;
      /** Where the value came from: the config file path or `KACHE_MAX_SIZE`. */
      readonly source: string;
    }
  | {
      readonly kind: 'unknown';
      readonly reason:
        | 'config-missing'
        | 'not-configured'
        | 'unparsable'
        | 'store-mismatch';
      readonly detail: string;
    };

/** The most recent kache garbage collection, from `gc_stats.json` beside the index. */
export interface KacheGcRun {
  readonly kind: 'ran';
  readonly lastRunAtMs: number;
  readonly durationMs: number | null;
  readonly entriesEvicted: number | null;
  /** Store-namespace bytes whose blob rows went away (not disk reclaimed). */
  readonly bytesFreed: number | null;
  readonly diskBytesReclaimed: number | null;
  readonly blobsRemoved: number | null;
  /** True when the run declined to evict because the store was under its trigger. */
  readonly declined: boolean;
  /** Victims left in place because a live build had just touched them. */
  readonly entriesPinned: number | null;
  /** Victims left in place because unlinking them would free no disk. */
  readonly entriesUnreclaimable: number | null;
  /**
   * Evictions the run abandoned with an error (`gc: skipping eviction of …`
   * in kache's `auto-gc.log` / `daemon.log` during the run); null when no
   * log beside the index could be read.
   */
  readonly evictionErrors: number | null;
  /** The error text those skips shared, e.g. `database is locked`. */
  readonly evictionErrorSample: string | null;
}

export type KacheGcReport =
  | { readonly kind: 'unavailable'; readonly reason: 'missing' | 'unparsable' }
  | KacheGcRun;

/** Cache-key computation time per rustc invocation (`key_ms` in the events sidecar). */
export interface KacheKeyTiming {
  /** Invocations sampled from the tail of `events.jsonl`. */
  readonly count: number;
  readonly meanMs: number;
  readonly p95Ms: number;
}

/** Store pressure beside the index: size against budget, the last GC, and key cost (#92). */
export interface KacheStorePressureReport {
  /**
   * kache's own store measure, `SUM(size)` over the index's `blobs` table
   * (deduplicated blob bytes, what `local_max_size` bounds); null when the
   * index has no readable blobs table.
   */
  readonly storeBytes: number | null;
  readonly limit: KacheStoreLimitReport;
  readonly gc: KacheGcReport;
  /** Null until the events tail yields a `key_ms` sample. */
  readonly keyTiming: KacheKeyTiming | null;
}

export interface KacheStatusReport {
  readonly available: boolean;
  readonly entryCount: number;
  readonly distinctCrates: number;
  readonly indexSizeBytes: number;
  readonly eventsFreshMs: number | null;
  readonly recentHeartbeatRoots: readonly KacheHeartbeatRoot[];
  readonly topCrates: readonly KacheTopCrate[];
  readonly pressure: KacheStorePressureReport;
}

export interface AttachmentSavingsModeReport {
  readonly mode: AttachMode;
  readonly ridersServed: number;
  readonly savedComputeMs: number;
  readonly savedComputeExactMs: number;
  readonly savedComputeEstimatedMs: number;
  readonly savedLatencyMs: number;
  readonly negativeLatencyRiders: number;
}

export interface AttachmentSavingsTotalsReport {
  readonly ridersServed: number;
  readonly savedComputeMs: number;
  readonly savedComputeExactMs: number;
  readonly savedComputeEstimatedMs: number;
  readonly savedLatencyMs: number;
  readonly negativeLatencyRiders: number;
}

export interface AttachmentSavingsReport {
  readonly byMode: readonly AttachmentSavingsModeReport[];
  readonly totals: AttachmentSavingsTotalsReport;
}

export interface StatusReport {
  readonly pid: number;
  readonly startedAtMs: number;
  readonly socketPath: string;
  readonly maxConcurrent: number;
  readonly lanes: readonly LaneStatus[];
  /** In-flight requests as bounded summary rows; the whole tail is behind `result` / `await`. */
  readonly active: readonly StatusRow[];
  readonly recent: readonly StatusRow[];
  readonly metrics: StatusMetrics;
  readonly savings: AttachmentSavingsReport;
  /**
   * Null when kache is not configured (no index path) or before the first
   * index read has completed.
   */
  readonly kache: KacheStatusReport | null;
  readonly system: SystemLoadReport;
  /**
   * The daemon's release version. Every client is the same install as the
   * daemon it talks to: `ensureDaemonRunning` replaces a daemon whose version
   * differs, so a report always names the caller's own version.
   */
  readonly version: string;
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
  /** Linux PSI memory `full avg10` percentage. */
  readonly memFullAvg10?: number;
  /** Linux PSI memory `some avg10` percentage, for diagnosis. */
  readonly memSomeAvg10?: number;
  /** Linux MemAvailable at report time. */
  readonly memAvailableBytes?: number;
  /** macOS VM pressure level: 1 normal, 2 warn, 4 critical. */
  readonly memPressureLevel?: 1 | 2 | 4;
  /** Memory admission state computed from the configured thresholds. */
  readonly memClamp: 'none' | 'soft' | 'hard';
  /** Heavy-leader cap state; absent when the cap is disabled. */
  readonly heavy?: HeavyAdmissionReport;
}

/** Heavy (release/perf/workspace) leaders under the low-memory concurrency cap. */
export interface HeavyAdmissionReport {
  /** Heavy leaders currently holding or about to take a permit. */
  readonly running: number;
  readonly maxConcurrent: number;
  /** True when MemAvailable is known and below the configured threshold. */
  readonly capActive: boolean;
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
  /**
   * Leaders expected to run before this one in its lane at submission time:
   * the running head plus the schedulable queued jobs ahead of it.
   */
  readonly position: number;
  /**
   * The tickets counted by `position`, in the order the lane expects to run
   * them. Sent (with `waitEtaMs`) only while the request is still in its
   * lane's queue when the ack is built; absent when it attached to a leader
   * or had already been admitted (an idle lane can start it before the ack
   * is flushed), when `position` alone reports the placement.
   */
  readonly ahead?: readonly string[];
  /** Prerequisites (`--after`) still unsettled; the request stays queued until they are. */
  readonly waitingFor?: readonly string[];
  /** Present when the request attached to an in-flight leader instead of queueing. */
  readonly attachedTo?: string;
  readonly attachMode?: AttachMode;
  /** Estimated remaining runtime for this queued request or its attached leader. */
  readonly etaMs?: number;
  /** Where `etaMs` came from; a `default` prior is a placeholder, not a measurement. */
  readonly etaSource?: EstimateSource;
  /**
   * Estimated wait before this request starts: the work queued ahead of it
   * in its lane plus the running head's remaining time. Absent when the
   * request attached to a leader or its lane was idle.
   */
  readonly waitEtaMs?: number;
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
  readonly code: 'bad-message' | 'bad-intent' | 'internal' | 'shutdown-refused';
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

export interface SessionPendingRecord {
  readonly createdAtMs: number;
  readonly estimateMs: number | null;
  readonly holdStop: boolean;
  readonly startedAtMs: number | null;
  readonly status: RequestStatus;
  readonly ticket: string;
}

export interface SessionCompletedRecord {
  readonly error: string | null;
  readonly errorCount: number | null;
  readonly exitCode: number | null;
  readonly status: FinishedStatus;
  readonly ticket: string;
  readonly warningCount: number | null;
}

export interface SessionPendingResultMessage {
  readonly type: 'session-pending-result';
  readonly id: string;
  readonly requests: readonly SessionPendingRecord[];
}

export interface SessionCompletedResultMessage {
  readonly type: 'session-completed-result';
  readonly id: string;
  readonly requests: readonly SessionCompletedRecord[];
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

/**
 * The `error` a starting daemon stamps on every request still active in the
 * ledger: the daemon that owned them stopped, and runs are not handed over
 * across a restart. Clients read it to explain the `killed` status.
 */
export const orphanedByRestartError = 'orphaned by daemon restart';

export const isOrphanedByRestart = (record: Pick<RequestRecord, 'status' | 'error'>): boolean =>
  record.status === 'killed' && record.error === orphanedByRestartError;

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
