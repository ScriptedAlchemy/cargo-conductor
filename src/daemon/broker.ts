import * as Cause from 'effect/Cause';
import * as Context from 'effect/Context';
import * as Data from 'effect/Data';
import * as Deferred from 'effect/Deferred';
import * as Effect from 'effect/Effect';
import * as Fiber from 'effect/Fiber';
import * as Layer from 'effect/Layer';
import * as Metric from 'effect/Metric';
import * as Queue from 'effect/Queue';
import * as Ref from 'effect/Ref';
import * as Semaphore from 'effect/Semaphore';
import * as ChildProcessSpawner from 'effect/unstable/process/ChildProcessSpawner';

import {
  batchCompatibleFor,
  batchExitShared,
  batchKindFor,
  composeNextestBatchArgv,
  composeTestBatchArgv,
  extraPackagesFor,
  maxBatchPackages,
  withExtraPackages,
} from './batch.js';
import { hasLibKind, parseCargoJsonLine } from './cargo-json.js';
import { DaemonConfig } from './config.js';
import { CostModel } from './cost.js';
import { attachModeFor } from './coverage.js';
import { executeCargo, TailBuffer } from './executor.js';
import type { ExecutionResult } from './executor.js';
import { normalizeCargoIntent } from './intent-normalizer.js';
import type { NormalizedCargoIntent } from './intent-normalizer.js';
import { Ledger } from './ledger.js';
import type {
  AttachMode,
  FinishedStatus,
  LaneStatus,
  RequestRecord,
  StatusReport,
} from './protocol.js';
import { ReplayBuffer } from './replay.js';
import type { ReplayAudience, ReplayChunk } from './replay.js';
import { selectNextIndex } from './scheduler.js';
import { Topology } from './topology.js';
import { findConfiguredTargetDir, locateWorkspaceRoot } from './workspace.js';

export interface SubmitInput {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly workspaceRoot?: string | undefined;
  readonly env?: Readonly<Record<string, string>> | undefined;
  readonly session?: string | undefined;
  readonly host?: string | undefined;
  readonly background?: boolean | undefined;
  readonly holdStop?: boolean | undefined;
}

export interface AttemptInput {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly session?: string | undefined;
  readonly host?: string | undefined;
  readonly reason: string;
}

export interface StartedInfo {
  readonly ticket: string;
  readonly waitMs: number;
}

export interface OutputInfo {
  readonly ticket: string;
  readonly channel: 'stdout' | 'stderr';
  readonly data: Uint8Array;
}

export interface ExitInfo {
  readonly ticket: string;
  readonly status: FinishedStatus;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly waitMs: number;
  readonly runMs: number;
  readonly error: string | null;
}

export interface RequeuedInfo {
  readonly ticket: string;
  readonly reason: string;
}

/**
 * Callbacks are invoked from lane worker fibers, potentially after the
 * originating connection is gone; the broker guards every invocation so a
 * failing callback can never take a lane down.
 */
export interface SubmitCallbacks {
  /**
   * Registers connection ownership in the same uninterruptible commit that
   * creates the ticket. False means the connection already closed.
   */
  readonly onRegistered?: (ticket: string) => Effect.Effect<boolean>;
  readonly onStarted: (info: StartedInfo) => Effect.Effect<void>;
  readonly onOutput: (info: OutputInfo) => Effect.Effect<void>;
  readonly onExit: (info: ExitInfo) => Effect.Effect<void>;
  readonly onRequeued?: (info: RequeuedInfo) => Effect.Effect<void>;
}

export interface SubmitResult {
  readonly ticket: string;
  readonly laneKey: string;
  readonly position: number;
  readonly attachedTo?: string;
  readonly attachMode?: AttachMode;
  /** Estimated remaining runtime for queued requests or their attached leader. */
  readonly etaMs?: number;
}

export interface KillOptions {
  readonly onlyIfQueued?: boolean;
}

export class CargoIntentError extends Data.TaggedError('CargoIntentError')<{
  readonly message: string;
}> {}

export interface AwaitTicketResult {
  readonly record: RequestRecord | null;
  readonly timedOut: boolean;
}

export interface BrokerApi {
  readonly submit: (
    input: SubmitInput,
    callbacks: SubmitCallbacks,
  ) => Effect.Effect<SubmitResult, CargoIntentError>;
  readonly recordAttempt: (
    input: AttemptInput,
  ) => Effect.Effect<{ readonly ticket: string }>;
  readonly kill: (ticket: string, options?: KillOptions) => Effect.Effect<boolean>;
  readonly report: (recentLimit?: number) => Effect.Effect<StatusReport>;
  readonly getTicket: (ticket: string) => Effect.Effect<RequestRecord | null>;
  readonly awaitTicket: (ticket: string, maxWaitMs: number) => Effect.Effect<AwaitTicketResult>;
  /** Test-only visibility for interruption cleanup assertions. */
  readonly _testWaiterCount: (ticket?: string) => Effect.Effect<number>;
  readonly sessionPending: (session: string) => Effect.Effect<readonly RequestRecord[]>;
  readonly sessionCompleted: (
    session: string,
    sinceMs: number,
  ) => Effect.Effect<readonly RequestRecord[]>;
}

export class Broker extends Context.Service<Broker, BrokerApi>()('cargo-conductor/Broker') {}

type JobState = 'queued' | 'starting' | 'kill-requested' | 'running' | 'finished';

interface Attachment {
  readonly id: number;
  readonly ticket: string;
  /** Assigned by tryRegisterAttachment in the same frame that registers it. */
  mode: AttachMode;
  readonly input: SubmitInput;
  readonly intent: NormalizedCargoIntent;
  readonly callbacks: SubmitCallbacks;
  readonly createdAtMs: number;
  readonly estimateMs: number;
  readonly tail: TailBuffer;
  attachedAtMs: number;
  /** True once the replay backlog is flushed; live output then flows directly. */
  live: boolean;
  startNotified: boolean;
  startedAtMs: number | null;
  readonly pendingLive: ReplayChunk[];
  diagnostics: DiagnosticAccumulator | null;
}

/** A fresh, not-yet-live attachment; `mode` may be reassigned at registration. */
const makeAttachment = (
  fields: Pick<
    Attachment,
    | 'id'
    | 'ticket'
    | 'mode'
    | 'input'
    | 'intent'
    | 'callbacks'
    | 'createdAtMs'
    | 'estimateMs'
    | 'tail'
    | 'attachedAtMs'
  >,
): Attachment => ({
  ...fields,
  live: false,
  startNotified: false,
  startedAtMs: null,
  pendingLive: [],
  diagnostics: null,
});

interface DiagnosticEntry {
  readonly order: number;
  readonly rendered: string;
}

interface DiagnosticAccumulator {
  errorCount: number;
  warningCount: number;
  readonly diagnostics: DiagnosticEntry[];
}

/** Per-unit completion state accumulated from the cargo JSON message stream. */
interface DemuxState {
  /** Package name -> target kinds with a completed compiler-artifact. */
  readonly unitKinds: Map<string, Set<string>>;
  /** Packages whose lib-shaped unit produced an error-level diagnostic. */
  readonly libErrors: Set<string>;
  readonly globalDiagnostics: DiagnosticAccumulator;
  readonly unscopedDiagnostics: DiagnosticAccumulator;
  readonly packageDiagnostics: Map<string, DiagnosticAccumulator>;
  nextDiagnosticOrder: number;
}

interface Job {
  readonly id: number;
  readonly ticket: string;
  readonly laneKey: string;
  readonly input: SubmitInput;
  readonly intent: NormalizedCargoIntent;
  readonly callbacks: SubmitCallbacks;
  readonly killSignal: Deferred.Deferred<void>;
  readonly state: Ref.Ref<JobState>;
  readonly queuedAtMs: number;
  readonly replay: ReplayBuffer;
  readonly attachments: Map<string, Attachment>;
  /** Closed (in the same sync frame as settlement) before exit fan-out begins. */
  readonly attachGate: { open: boolean };
  /** Argv actually executed (demux appends --message-format; batching may add -p). */
  execArgv: readonly string[];
  /** Non-null when the run is demultiplexed through cargo's JSON stream. */
  readonly demux: DemuxState | null;
  /** Leader-view output tail; authoritative for the ledger row. */
  readonly tail: TailBuffer;
  /** Cost-model estimate at submission; feeds lane scheduling. */
  readonly estimateMs: number;
  /** Real start of the cargo process, shared by attached ledger rows. */
  startedAtMs: number | null;
  /** Fail-fast signal captured at submission (topology stat, cached). */
  readonly editedRecently: boolean;
  /** Workspace-internal transitive deps of this job's packages (topology, cached). */
  readonly depClosure: ReadonlySet<string>;
}

const demuxSubcommands = new Set(['build', 'check', 'clippy']);
const maxDiagnostics = 5;
const maxDiagnosticLength = 2_000;

const makeDiagnosticAccumulator = (): DiagnosticAccumulator => ({
  errorCount: 0,
  warningCount: 0,
  diagnostics: [],
});

const copyDiagnosticAccumulator = (
  accumulator: DiagnosticAccumulator,
): DiagnosticAccumulator => ({
  errorCount: accumulator.errorCount,
  warningCount: accumulator.warningCount,
  diagnostics: [...accumulator.diagnostics],
});

const addDiagnostic = (
  accumulator: DiagnosticAccumulator,
  level: string | null,
  rendered: string | null,
  order: number,
): void => {
  if (level === 'error') {
    accumulator.errorCount += 1;
  } else if (level === 'warning') {
    accumulator.warningCount += 1;
  } else {
    return;
  }
  if (rendered !== null && rendered.length > 0 && accumulator.diagnostics.length < maxDiagnostics) {
    accumulator.diagnostics.push({
      order,
      rendered: rendered.slice(0, maxDiagnosticLength),
    });
  }
};

const mergeDiagnosticAccumulators = (
  accumulators: readonly DiagnosticAccumulator[],
): DiagnosticAccumulator => ({
  errorCount: accumulators.reduce((sum, item) => sum + item.errorCount, 0),
  warningCount: accumulators.reduce((sum, item) => sum + item.warningCount, 0),
  diagnostics: accumulators
    .flatMap((item) => item.diagnostics)
    .sort((left, right) => left.order - right.order)
    .slice(0, maxDiagnostics),
});

const diagnosticsForAttachment = (
  demux: DemuxState,
  attachment: Attachment,
): DiagnosticAccumulator => {
  if (attachment.mode === 'identity') {
    return copyDiagnosticAccumulator(demux.globalDiagnostics);
  }
  const accumulators = [demux.unscopedDiagnostics];
  for (const packageName of new Set(attachment.intent.packages)) {
    const scoped = demux.packageDiagnostics.get(packageName);
    if (scoped !== undefined) {
      accumulators.push(scoped);
    }
  }
  return mergeDiagnosticAccumulators(accumulators);
};

const diagnosticFinishFields = (
  accumulator: DiagnosticAccumulator | null,
): {
  readonly errorCount?: number;
  readonly warningCount?: number;
  readonly diagnostics?: readonly string[];
} =>
  accumulator === null
    ? {}
    : {
        errorCount: accumulator.errorCount,
        warningCount: accumulator.warningCount,
        diagnostics: accumulator.diagnostics.map((entry) => entry.rendered),
      };

/**
 * Demultiplexing rewrites the invocation to `--message-format=
 * json-diagnostic-rendered-ansi` so per-unit completion can be observed.
 * Skipped when the caller already chose a message format (their stream is
 * forwarded verbatim, unparsed) or passes trailing `--` arguments whose
 * semantics we do not model.
 */
const planDemux = (
  intent: NormalizedCargoIntent,
  argv: readonly string[],
): { readonly execArgv: readonly string[]; readonly demux: DemuxState | null } => {
  const eligible =
    demuxSubcommands.has(intent.subcommand) &&
    !argv.some((argument) => argument.startsWith('--message-format')) &&
    !argv.includes('--');
  if (!eligible) {
    return { execArgv: argv, demux: null };
  }
  return {
    execArgv: [...argv, '--message-format=json-diagnostic-rendered-ansi'],
    demux: {
      unitKinds: new Map(),
      libErrors: new Set(),
      globalDiagnostics: makeDiagnosticAccumulator(),
      unscopedDiagnostics: makeDiagnosticAccumulator(),
      packageDiagnostics: new Map(),
      nextDiagnosticOrder: 0,
    },
  };
};

/**
 * A coverage attachment can be released the moment its whole demand is
 * proven: v1 proves only `--lib` demands (a lib-shaped artifact for every
 * requested package with no error diagnostics on those lib units). Broader
 * demands wait for the leader (bin inventories need cargo metadata).
 */
const demandSatisfied = (intent: NormalizedCargoIntent, demux: DemuxState): boolean => {
  if (intent.workspace || intent.packages.length === 0) {
    return false;
  }
  if (intent.targets.length !== 1 || intent.targets[0] !== 'lib') {
    return false;
  }
  return intent.packages.every((name) => {
    const kinds = demux.unitKinds.get(name);
    return kinds !== undefined && hasLibKind(kinds) && !demux.libErrors.has(name);
  });
};

type InFlightEntry =
  | { readonly kind: 'leader'; readonly job: Job }
  | { readonly kind: 'attachment'; readonly leader: Job; readonly attachment: Attachment };

interface Lane {
  readonly key: string;
  readonly workspaceRoot: string;
  readonly targetDir: string;
  /** Pending jobs; the worker picks by schedule score, not arrival order. */
  readonly pending: Job[];
  /** Capacity-one coalescing signal; the awakened worker drains pending jobs. */
  readonly wake: Queue.Queue<void>;
  running: string | null;
}

/** Lane identity: one FIFO per (workspace root, resolved cargo target dir). */
export const laneKeyFor = (workspaceRoot: string, targetDir: string): string =>
  JSON.stringify([workspaceRoot, targetDir]);

const invalidLaneKey = 'invalid';

const cargoRunMetric = Metric.timer('cargo_run_ms', {
  boundaries: [1e3, 5e3, 15e3, 3e4, 6e4, 12e4, 3e5],
});
const jobOutcomeMetric = Metric.frequency('job_outcome', {
  preregisteredWords: ['done', 'failed', 'killed'],
});
const attachModeMetric = Metric.frequency('attach_mode', {
  preregisteredWords: ['identity', 'coverage', 'batch'],
});

const isTerminalStatus = (status: string): boolean =>
  status === 'done' ||
  status === 'failed' ||
  status === 'killed' ||
  status === 'denied' ||
  status === 'passthrough';

const guarded = (effect: Effect.Effect<void>): Effect.Effect<void> =>
  effect.pipe(
    Effect.tapDefect((cause) => Effect.logDebug('broker callback defect', cause)),
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.failCause(cause)
        : Effect.logError(`broker callback failed: ${Cause.pretty(cause)}`),
    ),
  );

const attachmentReceives = (attachment: Attachment, audience: ReplayAudience): boolean => {
  if (attachment.mode === 'identity') {
    return true;
  }
  switch (audience.kind) {
    case 'all':
      return true;
    case 'identity':
      return false;
    case 'package':
      return attachment.intent.packages.includes(audience.packageName);
    default: {
      const exhaustive: never = audience;
      return exhaustive;
    }
  }
};

const remainingEstimateMs = (job: Job, atMs: number): number =>
  job.startedAtMs === null ? job.estimateMs : Math.max(0, job.estimateMs - (atMs - job.startedAtMs));

const requeueReasonFor = (mode: AttachMode, status: FinishedStatus): string =>
  mode === 'identity'
    ? 'coalesced run was killed; running your request directly'
    : `${mode === 'batch' ? 'batched' : 'covering'} ${
        status === 'killed' ? 'run was killed' : 'run failed'
      }; running your request directly`;

export const BrokerLive: Layer.Layer<
  Broker,
  never,
  DaemonConfig | Ledger | CostModel | Topology | ChildProcessSpawner.ChildProcessSpawner
> = Layer.effect(
  Broker,
  Effect.gen(function* () {
    const config = yield* DaemonConfig;
    const ledger = yield* Ledger;
    yield* ledger.ingestPassthroughSpool(config.stateDir);
    const costModel = yield* CostModel;
    const topology = yield* Topology;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const daemonScope = yield* Effect.scope;
    const startedAtMs = Date.now();

    const admission = yield* Semaphore.make(config.maxConcurrent);
    const laneCreation = yield* Semaphore.make(1);
    const lanes = new Map<string, Lane>();
    const laneWorkers = new Set<Fiber.Fiber<never, never>>();
    const inFlight = new Map<string, InFlightEntry>();
    const ticketWaiters = new Map<string, Deferred.Deferred<RequestRecord>[]>();

    const removeTicketWaiter = (
      ticket: string,
      waiter: Deferred.Deferred<RequestRecord>,
    ): void => {
      const remaining = (ticketWaiters.get(ticket) ?? []).filter((item) => item !== waiter);
      if (remaining.length === 0) {
        ticketWaiters.delete(ticket);
      } else {
        ticketWaiters.set(ticket, remaining);
      }
    };

    const notifyWaiters = (ticket: string): Effect.Effect<void> =>
      Effect.gen(function* () {
        const waiters = ticketWaiters.get(ticket) ?? [];
        if (waiters.length === 0) {
          return;
        }
        ticketWaiters.delete(ticket);
        const record = yield* ledger.getRequestByTicket(ticket);
        if (record === null) {
          return;
        }
        yield* Effect.forEach(waiters, (waiter) => Deferred.succeed(waiter, record), {
          discard: true,
        });
      });

    const recoverDefect = <A>(fallback: A) => (cause: Cause.Cause<never>): Effect.Effect<A> =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.failCause(cause)
        : Effect.logError(`broker dependency failed: ${Cause.pretty(cause)}`).pipe(
            Effect.as(fallback),
          );

    /**
     * Fans one output chunk to the leader, the replay buffer, the leader-view
     * tail, and every attachment the filter admits. Coverage attachments see
     * only chunks relevant to their scope in demux mode; identity attachments
     * always see everything.
     */
    const emitChunk = (
      job: Job,
      channel: 'stdout' | 'stderr',
      data: Uint8Array,
      audience: ReplayAudience = { kind: 'all' },
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const liveAttachments = yield* Effect.sync(() => {
          job.replay.push(channel, data, audience);
          job.tail.push(data);
          const live: Attachment[] = [];
          for (const attachment of job.attachments.values()) {
            if (!attachmentReceives(attachment, audience)) {
              continue;
            }
            if (attachment.live) {
              live.push(attachment);
            } else {
              attachment.pendingLive.push({ channel, data: Buffer.from(data), audience });
            }
          }
          return live;
        });
        yield* guarded(job.callbacks.onOutput({ ticket: job.ticket, channel, data }));
        yield* Effect.forEach(
          liveAttachments,
          (attachment) =>
            Effect.sync(() => attachment.tail.push(data)).pipe(
              Effect.andThen(
                guarded(
                  attachment.callbacks.onOutput({ ticket: attachment.ticket, channel, data }),
                ),
              ),
            ),
          { discard: true },
        );
      });

    const emitChunks = (
      attachment: Attachment,
      chunks: readonly ReplayChunk[],
    ): Effect.Effect<void> =>
      Effect.forEach(
        chunks,
        (chunk) =>
          Effect.sync(() => attachment.tail.push(chunk.data)).pipe(
            Effect.andThen(
              guarded(
                attachment.callbacks.onOutput({
                  ticket: attachment.ticket,
                  channel: chunk.channel,
                  data: chunk.data,
                }),
              ),
            ),
          ),
        { discard: true },
      );

    /**
     * Replay the leader's buffered output, then drain anything that arrived
     * during the replay; `live` flips true in the same sync frame that
     * observes an empty pending queue, so no chunk is lost or reordered.
     */
    const replayThenGoLive = (job: Job, attachment: Attachment): Effect.Effect<void> =>
      Effect.gen(function* () {
        const snapshot = job.replay.snapshot();
        if (snapshot.droppedBytes > 0) {
          const notice = Buffer.from(
            `[cargo-conductor] replay truncated: ${snapshot.droppedBytes} earlier output bytes dropped\n`,
          );
          yield* Effect.sync(() => attachment.tail.push(notice));
          yield* guarded(
            attachment.callbacks.onOutput({
              ticket: attachment.ticket,
              channel: 'stderr',
              data: notice,
            }),
          );
        }
        yield* emitChunks(
          attachment,
          snapshot.chunks.filter((chunk) => attachmentReceives(attachment, chunk.audience)),
        );
        while (true) {
          const drained = yield* Effect.sync(() => {
            const batch = [...attachment.pendingLive];
            attachment.pendingLive.length = 0;
            if (batch.length === 0) {
              attachment.live = true;
            }
            return batch;
          });
          if (drained.length === 0) {
            return;
          }
          yield* emitChunks(attachment, drained);
        }
      });

    /**
     * At-most-once start notification per attachment; returns whether this
     * caller won. The winner owns the follow-up (replay for running-leader
     * attachments, direct live flag for queued-leader ones), so replayed and
     * live chunks can never interleave.
     */
    const notifyAttachmentStarted = (
      attachment: Attachment,
      atMs: number,
    ): Effect.Effect<boolean> =>
      Effect.gen(function* () {
        const won = yield* Effect.sync(() => {
          if (attachment.startNotified) {
            return false;
          }
          attachment.startNotified = true;
          attachment.startedAtMs = atMs;
          return true;
        });
        if (won) {
          yield* guarded(
            attachment.callbacks.onStarted({
              ticket: attachment.ticket,
              waitMs: Math.max(0, atMs - attachment.createdAtMs),
            }),
          );
        }
        return won;
      });

    const finishAttachment = (
      attachment: Attachment,
      atMs: number,
      exit: Omit<ExitInfo, 'ticket' | 'waitMs' | 'runMs'>,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const startedAtMs = attachment.startedAtMs;
        yield* ledger.markFinished(attachment.id, {
          status: exit.status,
          atMs,
          exitCode: exit.exitCode,
          signal: exit.signal,
          outputTail: attachment.tail.toString(),
          error: exit.error,
          ...diagnosticFinishFields(attachment.diagnostics),
        });
        yield* Metric.update(jobOutcomeMetric, exit.status);
        yield* notifyWaiters(attachment.ticket);
        const pending = yield* Effect.sync(() => {
          const batch = [...attachment.pendingLive];
          attachment.pendingLive.length = 0;
          return batch;
        });
        yield* emitChunks(attachment, pending);
        yield* guarded(
          attachment.callbacks.onExit({
            ticket: attachment.ticket,
            status: exit.status,
            exitCode: exit.exitCode,
            signal: exit.signal,
            waitMs: Math.max(
              0,
              (startedAtMs ?? attachment.attachedAtMs) - attachment.createdAtMs,
            ),
            runMs: startedAtMs === null ? 0 : Math.max(0, atMs - startedAtMs),
            error: exit.error,
          }),
        );
      });

    /** Deliver the at-most-once start notice plus one conductor stderr note, then finish. */
    const finishAttachmentWithNote = (
      attachment: Attachment,
      atMs: number,
      note: string,
      exit: Omit<ExitInfo, 'ticket' | 'waitMs' | 'runMs'>,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        yield* notifyAttachmentStarted(attachment, atMs);
        const noteData = Buffer.from(note);
        yield* Effect.sync(() => attachment.tail.push(noteData));
        yield* guarded(
          attachment.callbacks.onOutput({
            ticket: attachment.ticket,
            channel: 'stderr',
            data: noteData,
          }),
        );
        yield* finishAttachment(attachment, atMs, exit);
      });

    /**
     * Atomically registers `attachment` on a compatible in-flight leader in
     * the lane. Runs in one sync frame: the gate check and the registration
     * cannot interleave with settlement.
     */
    const tryRegisterAttachment = (
      laneKey: string,
      attachment: Attachment,
    ): Effect.Effect<{ readonly leader: Job; readonly mode: AttachMode } | null> =>
      Effect.sync(() => {
        const register = (job: Job, mode: AttachMode): { leader: Job; mode: AttachMode } => {
          attachment.mode = mode;
          attachment.attachedAtMs = Date.now();
          if (job.demux !== null) {
            attachment.diagnostics = diagnosticsForAttachment(job.demux, attachment);
          }
          job.attachments.set(attachment.ticket, attachment);
          inFlight.set(attachment.ticket, { kind: 'attachment', leader: job, attachment });
          return { leader: job, mode };
        };
        let coverageCandidate: Job | null = null;
        for (const entry of inFlight.values()) {
          if (entry.kind !== 'leader') {
            continue;
          }
          const job = entry.job;
          if (job.laneKey !== laneKey || !job.attachGate.open) {
            continue;
          }
          const mode = attachModeFor(job.intent, attachment.intent);
          if (mode === 'identity') {
            return register(job, 'identity');
          }
          if (mode === 'coverage' && coverageCandidate === null) {
            coverageCandidate = job;
          }
        }
        return coverageCandidate === null ? null : register(coverageCandidate, 'coverage');
      });

    const makeJob = (
      id: number,
      ticket: string,
      laneKey: string,
      input: SubmitInput,
      intent: NormalizedCargoIntent,
      callbacks: SubmitCallbacks,
      queuedAtMs: number,
      estimateMs: number,
    ): Effect.Effect<Job> =>
      Effect.gen(function* () {
        const killSignal = yield* Deferred.make<void>();
        const state = yield* Ref.make<JobState>('queued');
        const plan = planDemux(intent, input.argv);
        const editedRecently = yield* topology
          .editedRecently(intent.workspaceRoot, intent.packages)
          .pipe(Effect.catchCause(recoverDefect(false)));
        const depClosure = yield* topology
          .dependencyClosure(intent.workspaceRoot, intent.packages)
          .pipe(
            Effect.catchCause(
              recoverDefect<ReadonlySet<string>>(new Set<string>()),
            ),
          );
        return {
          id,
          ticket,
          laneKey,
          input,
          intent,
          callbacks,
          killSignal,
          state,
          queuedAtMs,
          replay: new ReplayBuffer(config.replayBufferBytes),
          attachments: new Map<string, Attachment>(),
          attachGate: { open: true },
          execArgv: plan.execArgv,
          demux: plan.demux,
          tail: new TailBuffer(config.outputTailBytes),
          estimateMs,
          startedAtMs: null,
          editedRecently,
          depClosure,
        };
      });

    /** Push to the lane's pending set and coalesce a worker wake-up. */
    const enqueueJob = (lane: Lane, job: Job): Effect.Effect<number> =>
      Effect.gen(function* () {
        const position = yield* Effect.sync(() => {
          lane.pending.push(job);
          return lane.pending.length - 1;
        });
        yield* Queue.offer(lane.wake, undefined);
        yield* Effect.logDebug('enqueued job', { position });
        return position;
      });

    /**
     * Splices out the best-scored pending job under the scheduling policy.
     * `unblocks` counts the other pending requests (and their coalesced
     * waiters) whose dependency closure this candidate compiles — running a
     * leaf crate first releases the dependents queued above it and warms
     * the artifacts they will reuse.
     */
    const takeNextJob = (lane: Lane): Effect.Effect<Job | undefined> =>
      Effect.sync(() => {
        const nowMs = Date.now();
        const index = selectNextIndex(
          lane.pending.map((candidate) => {
            let unblocks = 0;
            if (candidate.intent.packages.length > 0) {
              for (const other of lane.pending) {
                if (other === candidate || other.depClosure.size === 0) {
                  continue;
                }
                if (candidate.intent.packages.some((name) => other.depClosure.has(name))) {
                  unblocks += 1 + other.attachments.size;
                }
              }
            }
            return {
              id: candidate.id,
              estimateMs: candidate.estimateMs,
              waiters: candidate.attachments.size,
              unblocks,
              ageMs: nowMs - candidate.queuedAtMs,
              editedRecently: candidate.editedRecently,
            };
          }),
        );
        return index === -1 ? undefined : lane.pending.splice(index, 1)[0];
      });

    /**
     * Absorbs other queued compatible jobs onto `leader` as batch
     * attachments. check/build/clippy composites gain the followers' `-p`
     * flags; test/nextest composites rewrite the selection so one run serves
     * every participant (union of packages, `--test` targets, and filters).
     */
    const foldBatch = (lane: Lane, leader: Job): Effect.Effect<void> =>
      Effect.gen(function* () {
        const kind = config.batchEnabled ? batchKindFor(leader.intent) : null;
        if (kind === null) {
          return;
        }
        const extras: string[] = [];
        const absorbed: Job[] = [];
        const foldedAttachments: Attachment[] = [];
        const atMs = Date.now();
        yield* Effect.sync(() => {
          const named = new Set(leader.intent.packages);
          for (let index = lane.pending.length - 1; index >= 0; index -= 1) {
            const candidate = lane.pending[index];
            if (
              candidate === undefined ||
              !batchCompatibleFor(kind, leader.intent, candidate.intent)
            ) {
              continue;
            }
            const extra = extraPackagesFor(leader.intent, candidate.intent);
            if (named.size + extra.length > maxBatchPackages) {
              continue;
            }
            for (const name of extra) {
              named.add(name);
            }
            extras.push(...extra);
            absorbed.push(candidate);
            lane.pending.splice(index, 1);
            candidate.attachGate.open = false;
            inFlight.delete(candidate.ticket);
            const candidateAttachment = makeAttachment({
              id: candidate.id,
              ticket: candidate.ticket,
              mode: 'batch',
              input: candidate.input,
              intent: candidate.intent,
              callbacks: candidate.callbacks,
              createdAtMs: candidate.queuedAtMs,
              estimateMs: candidate.estimateMs,
              tail: new TailBuffer(config.outputTailBytes),
              attachedAtMs: atMs,
            });
            if (leader.demux !== null) {
              candidateAttachment.diagnostics = diagnosticsForAttachment(
                leader.demux,
                candidateAttachment,
              );
            }
            leader.attachments.set(candidateAttachment.ticket, candidateAttachment);
            inFlight.set(candidateAttachment.ticket, {
              kind: 'attachment',
              leader,
              attachment: candidateAttachment,
            });
            foldedAttachments.push(candidateAttachment);

            for (const attachment of candidate.attachments.values()) {
              switch (attachment.mode) {
                case 'identity':
                  attachment.mode = 'batch';
                  break;
                case 'coverage':
                case 'batch':
                  break;
                default: {
                  const exhaustive: never = attachment.mode;
                  return exhaustive;
                }
              }
              leader.attachments.set(attachment.ticket, attachment);
              inFlight.set(attachment.ticket, { kind: 'attachment', leader, attachment });
              foldedAttachments.push(attachment);
            }
            candidate.attachments.clear();
          }
        });
        if (absorbed.length === 0) {
          return;
        }
        yield* Effect.logDebug('folded queued jobs into batch', {
          attachments: foldedAttachments.length,
          leader: leader.ticket,
        });
        yield* Effect.forEach(
          foldedAttachments,
          (attachment) =>
            ledger.markAttached(attachment.id, {
              atMs,
              leaderTicket: leader.ticket,
              mode: attachment.mode,
            }).pipe(Effect.andThen(Metric.update(attachModeMetric, attachment.mode))),
          { discard: true },
        );
        yield* Effect.sync(() => {
          switch (kind) {
            case 'compile':
              if (extras.length > 0) {
                leader.execArgv = withExtraPackages(leader.execArgv, extras);
              }
              break;
            case 'test':
              leader.execArgv = composeTestBatchArgv(
                leader.execArgv,
                leader.intent,
                absorbed.map((job) => job.intent),
              );
              break;
            case 'nextest':
              leader.execArgv = composeNextestBatchArgv(
                leader.execArgv,
                leader.intent,
                absorbed.map((job) => job.intent),
              );
              break;
            default: {
              const exhaustive: never = kind;
              return exhaustive;
            }
          }
        });
      });

    /** Sync-removes one attachment from its leader; returns false if already gone. */
    const removeAttachment = (job: Job, attachment: Attachment): Effect.Effect<boolean> =>
      Effect.sync(() => {
        const present = job.attachments.delete(attachment.ticket);
        if (present) {
          inFlight.delete(attachment.ticket);
        }
        return present;
      });

    /** Early release of coverage attachments whose demand is fully proven or disproven. */
    const releaseSatisfiedAttachments = (job: Job): Effect.Effect<void> =>
      Effect.gen(function* () {
        const demux = job.demux;
        if (demux === null) {
          return;
        }
        const decided = yield* Effect.sync(() => {
          const releases: { attachment: Attachment; failed: string | null }[] = [];
          for (const attachment of job.attachments.values()) {
            if (attachment.mode === 'identity') {
              continue;
            }
            const errored = attachment.intent.packages.find((name) =>
              demux.libErrors.has(name),
            );
            if (errored !== undefined) {
              releases.push({ attachment, failed: errored });
            } else if (demandSatisfied(attachment.intent, demux)) {
              releases.push({ attachment, failed: null });
            }
          }
          for (const release of releases) {
            job.attachments.delete(release.attachment.ticket);
            inFlight.delete(release.attachment.ticket);
          }
          return releases;
        });
        if (decided.length > 0) {
          yield* Effect.logDebug('released attachments early', {
            count: decided.length,
            leader: job.ticket,
          });
        }
        const atMs = Date.now();
        yield* Effect.forEach(
          decided,
          ({ attachment, failed }) =>
            finishAttachmentWithNote(
              attachment,
              atMs,
              failed === null
                ? `[cargo-conductor] released early: requested packages compiled cleanly under ${job.ticket}\n`
                : `[cargo-conductor] released early: ${failed} failed to compile under ${job.ticket}\n`,
              failed === null
                ? { status: 'done', exitCode: 0, signal: null, error: null }
                : {
                    status: 'failed',
                    exitCode: 101,
                    signal: null,
                    error: `compile errors in ${failed}`,
                  },
            ),
          { discard: true },
        );
      });

    /**
     * Follow-up after tryRegisterAttachment wins: ledger the attach, and if
     * the leader is already running, deliver the start notice and replay
     * catch-up, then re-check early release — the demand may already be
     * proven by units that finished before this attachment arrived.
     */
    const completeAttachRegistration = (
      leader: Job,
      attachment: Attachment,
      mode: AttachMode,
      atMs: number,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        yield* Effect.logDebug('registered attachment', {
          leader: leader.ticket,
          mode,
        });
        yield* ledger.markAttached(attachment.id, { atMs, leaderTicket: leader.ticket, mode });
        yield* Metric.update(attachModeMetric, mode);
        if (leader.startedAtMs === null) {
          return;
        }
        yield* ledger.markRunning(attachment.id, leader.startedAtMs);
        const won = yield* notifyAttachmentStarted(attachment, leader.startedAtMs);
        if (won) {
          yield* replayThenGoLive(leader, attachment);
        }
        yield* releaseSatisfiedAttachments(leader);
      });

    /** Routes one line of the leader's JSON stdout stream. */
    const handleStdoutLine = (job: Job, line: string): Effect.Effect<void> => {
      const demux = job.demux;
      if (demux === null) {
        return emitChunk(job, 'stdout', Buffer.from(`${line}\n`));
      }
      const event = parseCargoJsonLine(line);
      if (event === null) {
        // Non-JSON stdout (test binaries, stray prints): leader and identity
        // attachments only — it cannot be attributed to a coverage scope.
        return emitChunk(job, 'stdout', Buffer.from(`${line}\n`), { kind: 'identity' });
      }
      switch (event.kind) {
        case 'artifact': {
          if (event.packageName === null) {
            return Effect.void;
          }
          const packageName = event.packageName;
          return Effect.sync(() => {
            const kinds = demux.unitKinds.get(packageName) ?? new Set<string>();
            for (const kind of event.targetKinds) {
              kinds.add(kind);
            }
            demux.unitKinds.set(packageName, kinds);
          }).pipe(Effect.andThen(releaseSatisfiedAttachments(job)));
        }
        case 'message': {
          const packageName = event.packageName;
          const recordDiagnostics = Effect.sync(() => {
            const order = demux.nextDiagnosticOrder;
            demux.nextDiagnosticOrder += 1;
            addDiagnostic(demux.globalDiagnostics, event.level, event.rendered, order);
            const scoped =
              packageName === null
                ? demux.unscopedDiagnostics
                : (demux.packageDiagnostics.get(packageName) ??
                  makeDiagnosticAccumulator());
            addDiagnostic(scoped, event.level, event.rendered, order);
            if (packageName !== null) {
              demux.packageDiagnostics.set(packageName, scoped);
            }
            const audience: ReplayAudience =
              packageName === null ? { kind: 'all' } : { kind: 'package', packageName };
            for (const attachment of job.attachments.values()) {
              if (!attachmentReceives(attachment, audience)) {
                continue;
              }
              const diagnostics = attachment.diagnostics ?? makeDiagnosticAccumulator();
              addDiagnostic(diagnostics, event.level, event.rendered, order);
              attachment.diagnostics = diagnostics;
            }
          });
          const record =
            event.level === 'error' && packageName !== null && hasLibKind(event.targetKinds)
              ? Effect.sync(() => {
                  demux.libErrors.add(packageName);
                })
              : Effect.void;
          const rendered = event.rendered;
          const forward =
            rendered === null || rendered.length === 0
              ? Effect.void
              : emitChunk(
                  job,
                  'stderr',
                  Buffer.from(rendered.endsWith('\n') ? rendered : `${rendered}\n`),
                  packageName === null
                    ? { kind: 'all' }
                    : { kind: 'package', packageName },
                );
          return recordDiagnostics.pipe(
            Effect.andThen(record),
            Effect.andThen(forward),
            Effect.andThen(releaseSatisfiedAttachments(job)),
          );
        }
        case 'build-finished':
        case 'other':
          return Effect.void;
        default: {
          const exhaustive: never = event;
          return exhaustive;
        }
      }
    };

    /**
     * Closes the attachment gate and detaches every attachment in one sync
     * frame; nothing can attach to `job` afterwards.
     */
    const detachAll = (job: Job): Effect.Effect<readonly Attachment[]> =>
      Effect.sync(() => {
        job.attachGate.open = false;
        const detached = [...job.attachments.values()];
        job.attachments.clear();
        for (const attachment of detached) {
          inFlight.delete(attachment.ticket);
        }
        return detached;
      });

    /**
     * Puts a detached attachment back on its lane as an independent job,
     * first trying to re-attach to another in-flight leader so a killed
     * leader with N identity followers becomes one rerun, not N.
     */
    const requeueAttachment = (
      lane: Lane,
      attachment: Attachment,
      reason: string,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const atMs = Date.now();
        yield* Effect.logDebug('requeueing attachment', {
          reason,
          ticket: attachment.ticket,
        });
        yield* ledger.markRequeued(attachment.id, atMs);
        const onRequeued = attachment.callbacks.onRequeued;
        if (onRequeued !== undefined) {
          yield* guarded(onRequeued({ ticket: attachment.ticket, reason }));
        }
        const revived = makeAttachment({
          id: attachment.id,
          ticket: attachment.ticket,
          mode: attachment.mode,
          input: attachment.input,
          intent: attachment.intent,
          callbacks: attachment.callbacks,
          createdAtMs: attachment.createdAtMs,
          estimateMs: attachment.estimateMs,
          tail: attachment.tail,
          attachedAtMs: atMs,
        });
        const reattached = yield* tryRegisterAttachment(lane.key, revived);
        if (reattached !== null) {
          yield* completeAttachRegistration(reattached.leader, revived, reattached.mode, atMs);
          return;
        }
        const job = yield* makeJob(
          attachment.id,
          attachment.ticket,
          lane.key,
          attachment.input,
          attachment.intent,
          attachment.callbacks,
          atMs,
          attachment.estimateMs,
        );
        yield* Effect.sync(() => inFlight.set(job.ticket, { kind: 'leader', job }));
        yield* enqueueJob(lane, job);
      });

    /** Mirrors or requeues every attachment after the leader reached `status`. */
    const settleAttachments = (
      lane: Lane | null,
      job: Job,
      status: FinishedStatus,
      exitCode: number | null,
      signal: string | null,
      error: string | null,
      atMs: number,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const detached = yield* detachAll(job);
        if (detached.length === 0) {
          return;
        }
        for (const attachment of detached) {
          // A failed leader can still prove a coverage demand: the demanded
          // units may have compiled cleanly before an unrelated unit failed.
          const provenDespiteFailure =
            status === 'failed' &&
            attachment.mode !== 'identity' &&
            job.demux !== null &&
            demandSatisfied(attachment.intent, job.demux);
          // Folded test composites run with --no-fail-fast and share their
          // exit: a failed composite IS the participant's failure. Compile
          // batches requeue instead (the failure may be a foreign package).
          const mirrors =
            status === 'done' ||
            (status === 'failed' &&
              (attachment.mode === 'identity' ||
                (attachment.mode === 'batch' && batchExitShared(job.intent))));
          if (provenDespiteFailure) {
            yield* finishAttachmentWithNote(
              attachment,
              atMs,
              `[cargo-conductor] ${job.ticket} failed elsewhere, but your requested packages compiled cleanly\n`,
              { status: 'done', exitCode: 0, signal: null, error: null },
            );
          } else if (mirrors) {
            yield* notifyAttachmentStarted(attachment, atMs);
            yield* finishAttachment(attachment, atMs, { status, exitCode, signal, error });
          } else if (lane !== null) {
            yield* requeueAttachment(lane, attachment, requeueReasonFor(attachment.mode, status));
          } else {
            yield* finishAttachment(
              attachment,
              atMs,
              { status: 'killed', exitCode: null, signal: null, error: 'daemon shutdown' },
            );
          }
        }
      });

    const completeExit = (job: Job): Effect.Effect<void> =>
      Effect.gen(function* () {
        const lane = lanes.get(job.laneKey);
        if (lane !== undefined) {
          yield* Effect.sync(() => {
            if (lane.running === job.ticket) {
              lane.running = null;
            }
          });
        }
        yield* Effect.sync(() => inFlight.delete(job.ticket));
      });

    const claimSettlement = (job: Job): Effect.Effect<boolean> =>
      Ref.modify(job.state, (state): readonly [boolean, JobState] =>
        state === 'finished' ? [false, state] : [true, 'finished'],
      );

    /**
     * The single idempotent settlement path for every claimed leader
     * lifecycle. Once the state claim wins, ledger rows, waiter notification,
     * in-flight cleanup, callbacks, and attachments complete uninterruptibly.
     */
    const settleJob = (
      attachmentLane: Lane | null,
      job: Job,
      status: FinishedStatus,
      exitCode: number | null,
      signal: string | null,
      error: string | null,
      atMs: number,
    ): Effect.Effect<void> =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          const won = yield* claimSettlement(job);
          if (!won) {
            return;
          }
          const startedAtMs = job.startedAtMs;
          yield* ledger.markFinished(job.id, {
            status,
            atMs,
            exitCode,
            signal,
            outputTail: startedAtMs === null ? null : job.tail.toString(),
            error,
            ...diagnosticFinishFields(job.demux?.globalDiagnostics ?? null),
          });
          yield* Metric.update(jobOutcomeMetric, status);
          yield* notifyWaiters(job.ticket);
          yield* completeExit(job);
          yield* guarded(
            job.callbacks.onExit({
              ticket: job.ticket,
              status,
              exitCode,
              signal,
              waitMs: Math.max(0, (startedAtMs ?? atMs) - job.queuedAtMs),
              runMs: startedAtMs === null ? 0 : Math.max(0, atMs - startedAtMs),
              error,
            }),
          );
          yield* settleAttachments(
            attachmentLane,
            job,
            status,
            exitCode,
            signal,
            error,
            atMs,
          );
        }),
      );

    const finishKilledBeforeRun = (lane: Lane, job: Job): Effect.Effect<void> =>
      settleJob(lane, job, 'killed', null, null, 'killed while queued', Date.now());

    const settleInterruptedJob = (job: Job): Effect.Effect<void> =>
      settleJob(null, job, 'killed', null, 'SIGTERM', 'daemon shutdown', Date.now()).pipe(
        Effect.ignore,
      );

    const claimStart = (job: Job): Effect.Effect<boolean> =>
      Ref.modify(job.state, (state): readonly [boolean, JobState] =>
        state === 'queued' ? [true, 'starting'] : [false, state],
      );

    const runAdmitted = (lane: Lane, job: Job): Effect.Effect<void> =>
      Effect.gen(function* () {
        const starts = yield* claimStart(job);
        if (!starts) {
          const state = yield* Ref.get(job.state);
          if (state === 'kill-requested') {
            yield* finishKilledBeforeRun(lane, job);
          }
          return;
        }
        yield* Effect.logDebug('starting admitted job');
        const runStartedAtMs = Date.now();
        const queuedAttachments = yield* Effect.sync(() => {
          job.startedAtMs = runStartedAtMs;
          return [...job.attachments.values()];
        });
        yield* Effect.sync(() => {
          lane.running = job.ticket;
        });
        // execArgv already carries the demux flag and any batch-folded -p
        // packages: this is the invocation the ledger reports as "ran as".
        yield* ledger.markRunning(job.id, runStartedAtMs, job.execArgv);
        yield* Ref.set(job.state, 'running');
        const waitMs = runStartedAtMs - job.queuedAtMs;
        yield* Effect.annotateCurrentSpan('waitMs', waitMs);
        yield* guarded(job.callbacks.onStarted({ ticket: job.ticket, waitMs }));
        yield* Effect.forEach(
          queuedAttachments,
          (attachment) =>
            Effect.gen(function* () {
              yield* ledger.markRunning(attachment.id, runStartedAtMs);
              const won = yield* notifyAttachmentStarted(attachment, runStartedAtMs);
              if (won) {
                // The winner attached while the leader was queued: no output
                // exists yet, so it goes live directly (no replay needed).
                yield* Effect.sync(() => {
                  attachment.live = true;
                });
              }
            }),
          { discard: true },
        );
        // Split the machine between admitted builds unless the caller chose
        // its own parallelism (flag or env). Uniform for all callers, so it
        // never fragments intent identity.
        const grantsJobs =
          config.jobsGrant > 0 &&
          job.input.env?.CARGO_BUILD_JOBS === undefined &&
          !job.input.argv.some(
            (argument) => argument === '-j' || argument.startsWith('--jobs') || /^-j\d+$/u.test(argument),
          );
        const execEnv = grantsJobs
          ? { ...job.input.env, CARGO_BUILD_JOBS: String(config.jobsGrant) }
          : job.input.env;
        const result: ExecutionResult = yield* executeCargo({
          argv: job.execArgv,
          cwd: job.input.cwd,
          env: execEnv,
          killSignal: job.killSignal,
          // The broker-side tail (fed by emitChunk) is authoritative: in
          // demux mode the executor's own tail would capture raw JSON.
          tailBytes: 0,
          onOutput: (channel, data) => emitChunk(job, channel, data),
          ...(job.demux === null
            ? {}
            : { onStdoutLine: (line: string) => handleStdoutLine(job, line) }),
        }).pipe(
          Effect.withSpan('cargo.exec'),
          Effect.trackDuration(cargoRunMetric),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        );
        const finishedAtMs = Date.now();
        if (result.outcome === 'done') {
          yield* costModel.recordOutcome(job.intent.key, finishedAtMs - runStartedAtMs);
        }
        yield* settleJob(
          lane,
          job,
          result.outcome,
          result.exitCode,
          result.signal,
          result.error,
          finishedAtMs,
        );
      }).pipe(
        Effect.withSpan('job.process', {
          attributes: { ticket: job.ticket, lane: lane.key },
        }),
      );

    const processJob = (lane: Lane, job: Job): Effect.Effect<void> =>
      Effect.gen(function* () {
        const state = yield* Ref.get(job.state);
        if (state === 'kill-requested') {
          yield* finishKilledBeforeRun(lane, job);
          return;
        }
        if (state === 'finished') {
          return;
        }
        yield* admission.withPermits(1)(runAdmitted(lane, job));
      }).pipe(Effect.onInterrupt(() => settleInterruptedJob(job)));

    const processLaneJob = (lane: Lane, job: Job): Effect.Effect<void> =>
      Effect.gen(function* () {
        yield* foldBatch(lane, job);
        yield* processJob(lane, job);
      }).pipe(
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) {
            return Effect.failCause(cause);
          }
          const message = Cause.pretty(cause);
          return Effect.logError(`lane ${lane.key} job ${job.ticket} crashed`, cause).pipe(
            Effect.andThen(
              settleJob(lane, job, 'failed', null, null, message, Date.now()).pipe(
                Effect.ignore,
              ),
            ),
          );
        }),
      );

    const drainLane = (lane: Lane): Effect.Effect<void> =>
      Effect.gen(function* () {
        while (true) {
          const job = yield* takeNextJob(lane);
          if (job === undefined) {
            return;
          }
          yield* processLaneJob(lane, job).pipe(
            Effect.annotateLogs({ ticket: job.ticket, lane: lane.key }),
          );
        }
      });

    const laneWorker = (lane: Lane): Effect.Effect<never> =>
      Effect.forever(
        Queue.take(lane.wake).pipe(
          Effect.andThen(drainLane(lane)),
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.failCause(cause)
              : Effect.logError(`lane ${lane.key} iteration crashed`, cause),
          ),
        ),
      );

    const getOrCreateLane = (
      key: string,
      workspaceRoot: string,
      targetDir: string,
    ): Effect.Effect<Lane> =>
      laneCreation.withPermits(1)(
        Effect.gen(function* () {
          const existing = lanes.get(key);
          if (existing !== undefined) {
            return existing;
          }
          const wake = yield* Queue.dropping<void>(1);
          const lane: Lane = {
            key,
            workspaceRoot,
            targetDir,
            pending: [],
            wake,
            running: null,
          };
          lanes.set(key, lane);
          const worker = yield* Effect.forkIn(laneWorker(lane), daemonScope);
          yield* Effect.sync(() => laneWorkers.add(worker));
          return lane;
        }),
      );

    const recordRejectedIntent = (
      input: SubmitInput,
      workspaceRoot: string,
      createdAtMs: number,
      message: string,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const created = yield* ledger.createRequest({
          createdAtMs,
          session: input.session ?? null,
          host: input.host ?? null,
          cwd: input.cwd,
          workspaceRoot,
          targetDir: '',
          laneKey: invalidLaneKey,
          argv: input.argv,
          intentKey: null,
          intentJson: null,
        });
        yield* ledger.markFinished(created.id, {
          status: 'failed',
          atMs: createdAtMs,
          error: message,
        });
      });

    // Normalization and lane creation stay interruptible: forking the lane
    // worker inside an uninterruptible region would make the worker fiber
    // inherit uninterruptibility, which hangs the executor's internal race
    // (the winner can never interrupt the loser) and blocks daemon teardown.
    // Only the ledger-insert + attach/enqueue section is atomic, so a
    // connection dying mid-submit can never leave a ledger row without a
    // queued job or a registered attachment.
    const registerOwnership = (
      callbacks: SubmitCallbacks,
      ticket: string,
    ): Effect.Effect<boolean> =>
      callbacks.onRegistered === undefined
        ? Effect.succeed(true)
        : callbacks.onRegistered(ticket).pipe(
            Effect.catchCause((cause) =>
              Effect.logError(
                `ticket ${ticket} ownership registration failed: ${Cause.pretty(cause)}`,
              ).pipe(Effect.as(false)),
            ),
          );

    const submit = (
      input: SubmitInput,
      callbacks: SubmitCallbacks,
    ): Effect.Effect<SubmitResult, CargoIntentError> =>
      Effect.gen(function* () {
        const createdAtMs = Date.now();
        const workspaceRoot = yield* Effect.sync(
          () => input.workspaceRoot ?? locateWorkspaceRoot(input.cwd, { argv: input.argv }),
        );
        const normalized = yield* Effect.try({
          try: () =>
            normalizeCargoIntent({
              argv: input.argv,
              cwd: input.cwd,
              env: input.env ?? {},
              workspaceRoot,
              configuredTargetDir: findConfiguredTargetDir(input.cwd, workspaceRoot, {
                argv: input.argv,
                env: input.env ?? {},
              }),
            }),
          catch: (cause) =>
            new CargoIntentError({
              message: cause instanceof Error ? cause.message : String(cause),
            }),
        }).pipe(
          Effect.tapError((error) =>
            Effect.uninterruptible(
              recordRejectedIntent(input, workspaceRoot, createdAtMs, error.message),
            ),
          ),
        );
        const laneKey = laneKeyFor(normalized.workspaceRoot, normalized.targetDir);
        const lane = yield* getOrCreateLane(
          laneKey,
          normalized.workspaceRoot,
          normalized.targetDir,
        );
        return yield* Effect.uninterruptible(
          Effect.gen(function* () {
            const holdStop =
              input.holdStop ?? (input.session !== undefined && input.background !== true);
            // Closure-aware ETA: uncompiled workspace dependencies dominate
            // cold builds. The topology lookup is cached and non-blocking.
            const closure = yield* topology.dependencyClosure(
              normalized.workspaceRoot,
              normalized.packages,
            );
            const estimate = yield* costModel.estimate(normalized, closure);
            const created = yield* ledger.createRequest({
              createdAtMs,
              session: input.session ?? null,
              host: input.host ?? null,
              cwd: normalized.cwd,
              workspaceRoot: normalized.workspaceRoot,
              targetDir: normalized.targetDir,
              laneKey,
              argv: input.argv,
              intentKey: normalized.key,
              intentJson: JSON.stringify(normalized),
              background: input.background === true,
              holdStop,
              estimateMs: estimate.estimateMs,
            });
            const attachment = makeAttachment({
              id: created.id,
              ticket: created.ticket,
              mode: 'identity',
              input,
              intent: normalized,
              callbacks,
              createdAtMs,
              estimateMs: estimate.estimateMs,
              tail: new TailBuffer(config.outputTailBytes),
              attachedAtMs: createdAtMs,
            });
            const registered = yield* tryRegisterAttachment(laneKey, attachment);
            if (registered !== null) {
              yield* registerOwnership(callbacks, created.ticket);
              yield* completeAttachRegistration(
                registered.leader,
                attachment,
                registered.mode,
                Date.now(),
              );
              return {
                ticket: created.ticket,
                laneKey,
                position: 0,
                attachedTo: registered.leader.ticket,
                attachMode: registered.mode,
                etaMs: remainingEstimateMs(registered.leader, Date.now()),
              };
            }
            const job = yield* makeJob(
              created.id,
              created.ticket,
              laneKey,
              input,
              normalized,
              callbacks,
              createdAtMs,
              estimate.estimateMs,
            );
            yield* Effect.sync(() => inFlight.set(job.ticket, { kind: 'leader', job }));
            yield* ledger.markQueued(created.id, createdAtMs);
            const ownershipAccepted = yield* registerOwnership(callbacks, created.ticket);
            if (!ownershipAccepted) {
              yield* Ref.set(job.state, 'kill-requested');
              yield* Deferred.succeed(job.killSignal, undefined);
            }
            const position = yield* enqueueJob(lane, job);
            return { ticket: created.ticket, laneKey, position, etaMs: job.estimateMs };
          }),
        );
      });

    const getTicket = (ticket: string): Effect.Effect<RequestRecord | null> =>
      ledger.getRequestByTicket(ticket);

    const recordAttempt = (
      input: AttemptInput,
    ): Effect.Effect<{ readonly ticket: string }> =>
      ledger
        .recordAttempt({
          argv: input.argv,
          atMs: Date.now(),
          cwd: input.cwd,
          error: input.reason,
          host: input.host ?? null,
          session: input.session ?? null,
          status: 'denied',
        })
        .pipe(Effect.map(({ ticket }) => ({ ticket })));

    const awaitTicket = (ticket: string, maxWaitMs: number): Effect.Effect<AwaitTicketResult> =>
      Effect.acquireUseRelease(
        Effect.gen(function* () {
          const waiter = yield* Deferred.make<RequestRecord>();
          yield* Effect.sync(() => {
            const existing = ticketWaiters.get(ticket) ?? [];
            existing.push(waiter);
            ticketWaiters.set(ticket, existing);
          });
          return waiter;
        }),
        (waiter) =>
          Effect.gen(function* () {
            const current = yield* ledger.getRequestByTicket(ticket);
            if (current === null) {
              return { record: null, timedOut: false };
            }
            if (isTerminalStatus(current.status)) {
              return { record: current, timedOut: false };
            }
            return yield* Deferred.await(waiter).pipe(
              Effect.timeout(`${Math.max(0, maxWaitMs)} millis`),
              Effect.map((record) => ({ record, timedOut: false })),
              Effect.catchTag('TimeoutError', () =>
                ledger.getRequestByTicket(ticket).pipe(
                  Effect.map((record) => ({
                    record,
                    timedOut: record === null || !isTerminalStatus(record.status),
                  })),
                ),
              ),
            );
          }),
        (waiter) => Effect.sync(() => removeTicketWaiter(ticket, waiter)),
      );

    const _testWaiterCount = (ticket?: string): Effect.Effect<number> =>
      Effect.sync(() =>
        ticket === undefined
          ? [...ticketWaiters.values()].reduce((total, waiters) => total + waiters.length, 0)
          : (ticketWaiters.get(ticket)?.length ?? 0),
      );

    const sessionPending = (session: string): Effect.Effect<readonly RequestRecord[]> =>
      Effect.gen(function* () {
        const active = yield* ledger.activeRequests();
        return active.filter((record) => record.session === session && record.holdStop);
      });

    const sessionCompleted = (
      session: string,
      sinceMs: number,
    ): Effect.Effect<readonly RequestRecord[]> =>
      Effect.gen(function* () {
        const recent = yield* ledger.recentRequests(200);
        return recent.filter(
          (record) =>
            record.session === session &&
            record.finishedAtMs !== null &&
            record.finishedAtMs >= sinceMs &&
            isTerminalStatus(record.status),
        );
      });

    const killAttachment = (entry: {
      readonly leader: Job;
      readonly attachment: Attachment;
    }): Effect.Effect<boolean> =>
      Effect.gen(function* () {
        const removed = yield* removeAttachment(entry.leader, entry.attachment);
        if (!removed) {
          return false;
        }
        yield* finishAttachment(
          entry.attachment,
          Date.now(),
          { status: 'killed', exitCode: null, signal: null, error: 'detached by kill' },
        );
        return true;
      });

    const kill = (ticket: string, options?: KillOptions): Effect.Effect<boolean> =>
      Effect.gen(function* () {
        const entry = inFlight.get(ticket);
        if (entry === undefined) {
          return false;
        }
        if (entry.kind === 'attachment') {
          // Attachments hold no compute; disconnect cleanup (onlyIfQueued)
          // leaves them alive so their result still lands in the ledger.
          if (options?.onlyIfQueued === true) {
            return false;
          }
          return yield* killAttachment(entry);
        }
        const job = entry.job;
        if (options?.onlyIfQueued === true) {
          const claimed = yield* Ref.modify(
            job.state,
            (state): readonly [boolean, JobState] =>
              state === 'queued' ? [true, 'kill-requested'] : [false, state],
          );
          if (!claimed) {
            return false;
          }
          yield* Deferred.succeed(job.killSignal, undefined);
          return true;
        }
        const signal = yield* Ref.modify(
          job.state,
          (state): readonly [boolean, JobState] => {
            switch (state) {
              case 'queued':
                return [true, 'kill-requested'];
              case 'starting':
              case 'running':
                return [true, state];
              case 'kill-requested':
                return [true, state];
              case 'finished':
                return [false, state];
              default: {
                const exhaustive: never = state;
                return exhaustive;
              }
            }
          },
        );
        if (signal) {
          yield* Deferred.succeed(job.killSignal, undefined);
        }
        return signal;
      });

    const report = (recentLimit = 50): Effect.Effect<StatusReport> =>
      Effect.gen(function* () {
        yield* ledger.ingestPassthroughSpool(config.stateDir);
        const laneStatuses: LaneStatus[] = [];
        for (const lane of lanes.values()) {
          laneStatuses.push(
            yield* Effect.sync(() => ({
              key: lane.key,
              workspaceRoot: lane.workspaceRoot,
              targetDir: lane.targetDir,
              queued: lane.pending.length,
              runningTicket: lane.running,
            })),
          );
        }
        const active = yield* ledger.activeRequests();
        const recent = yield* ledger.recentRequests(recentLimit);
        const cargoRun = yield* Metric.value(cargoRunMetric);
        const jobOutcome = yield* Metric.value(jobOutcomeMetric);
        const attachMode = yield* Metric.value(attachModeMetric);
        return {
          pid: process.pid,
          startedAtMs,
          socketPath: config.socketPath,
          maxConcurrent: config.maxConcurrent,
          lanes: laneStatuses,
          active,
          recent,
          metrics: {
            cargo_run_ms: {
              buckets: cargoRun.buckets.map(([boundary, count]) => [
                Number.isFinite(boundary) ? boundary : null,
                count,
              ] as const),
              count: cargoRun.count,
              min: cargoRun.count === 0 ? null : cargoRun.min,
              max: cargoRun.count === 0 ? null : cargoRun.max,
              sum: cargoRun.sum,
            },
            job_outcome: Object.fromEntries(jobOutcome.occurrences),
            attach_mode: Object.fromEntries(attachMode.occurrences),
          },
        };
      });

    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        const workers = yield* Effect.sync(() => [...laneWorkers]);
        yield* Effect.forEach(workers, Fiber.interrupt, {
          concurrency: 'unbounded',
          discard: true,
        });
        yield* Effect.sync(() => laneWorkers.clear());
        const remaining = yield* Effect.sync(() => {
          const jobs = new Set<Job>();
          for (const entry of inFlight.values()) {
            switch (entry.kind) {
              case 'leader':
                jobs.add(entry.job);
                break;
              case 'attachment':
                jobs.add(entry.leader);
                break;
              default: {
                const exhaustive: never = entry;
                return exhaustive;
              }
            }
          }
          return [...jobs];
        });
        yield* Effect.forEach(remaining, settleInterruptedJob, {
          concurrency: 1,
          discard: true,
        });
      }),
    );

    return {
      submit,
      recordAttempt,
      kill,
      report,
      getTicket,
      awaitTicket,
      _testWaiterCount,
      sessionPending,
      sessionCompleted,
    } satisfies BrokerApi;
  }),
);
