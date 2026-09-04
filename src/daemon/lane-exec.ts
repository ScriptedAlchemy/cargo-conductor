import { availableParallelism, loadavg } from 'node:os';

import * as Cause from 'effect/Cause';
import * as Deferred from 'effect/Deferred';
import * as Effect from 'effect/Effect';
import * as Fiber from 'effect/Fiber';
import * as Metric from 'effect/Metric';
import * as Queue from 'effect/Queue';
import * as Ref from 'effect/Ref';
import * as Semaphore from 'effect/Semaphore';
import * as ChildProcessSpawner from 'effect/unstable/process/ChildProcessSpawner';
import type { Scope } from 'effect/Scope';

import { makeAttachmentRuntime } from './attachments.js';
import type { AttachmentRuntime } from './attachments.js';
import {
  batchCompatibleFor,
  batchKindFor,
  composeTestFoldArgv,
  extraPackagesFor,
  maxBatchPackages,
  withExtraPackages,
} from './batch.js';
import {
  attachModeMetric,
  cargoRunByKindMetric,
  cargoRunMetric,
  jobOutcomeMetric,
  waitMsSummary,
} from './broker-metrics.js';
import type { DaemonConfigShape } from './config.js';
import type { CostEstimate, CostModelApi } from './cost.js';
import { executeCargo, TailBuffer } from './executor.js';
import type { ExecutionResult } from './executor.js';
import type { NormalizedCargoIntent } from './intent-normalizer.js';
import {
  diagnosticFinishFields,
  diagnosticsForAttachment,
  guarded,
  makeAttachment,
  planDemux,
  quietMsSinceOutput,
  queuedWaitIsDelayed,
  remainingEstimateMs,
  settlementStep,
} from './job-state.js';
import type { Attachment, Job, JobState, SubmitCallbacks, SubmitInput } from './job-state.js';
import { isSharedJobserverArmed } from './jobserver.js';
import type { LedgerApi } from './ledger.js';
import {
  cpuSomeAvg10,
  memoryAvailableBytes,
  memoryPressureLevel,
  memoryPsi,
} from './pressure.js';
import type {
  AdmissionHold,
  FinishedStatus,
  HeavyAdmissionReport,
  LaneStatus,
  QueueContext,
  StallReport,
} from './protocol.js';
import { ReplayBuffer } from './replay.js';
import {
  admissionDecision,
  admissionHoldFor,
  heavyCapActive,
  isHeavyIntent,
  selectNextIndex,
} from './scheduler.js';
import type { AdmissionLoadInput } from './scheduler.js';
import type { TicketDirectory } from './ticket-directory.js';
import type { TopologyApi } from './topology.js';

export interface Lane {
  readonly key: string;
  readonly workspaceRoot: string;
  readonly targetDir: string;
  /** Pending jobs; the worker picks by schedule score, not arrival order. */
  readonly pending: Job[];
  /** Capacity-one coalescing signal; the awakened worker drains pending jobs. */
  readonly wake: Queue.Queue<void>;
  running: string | null;
  /**
   * The job the worker took from `pending`, from the batch window through
   * settlement. While it is parked at the load gate or on the permit it is
   * in neither `pending` nor `running`, yet it still runs ahead of the queue.
   */
  head: Job | null;
}

/** Lane identity: one FIFO per (workspace root, resolved cargo target dir). */
export const laneKeyFor = (workspaceRoot: string, targetDir: string): string =>
  JSON.stringify([workspaceRoot, targetDir]);

const pinsJobs = (argument: string): boolean =>
  argument === '-j' || argument.startsWith('--jobs') || /^-j\d+$/u.test(argument);

/**
 * Environment for a spawned cargo. The machine-wide jobserver FIFO owns
 * parallelism whenever the daemon armed it: cargo only joins an inherited
 * jobserver while `-j`/`build.jobs` is unset, so pinning `CARGO_BUILD_JOBS`
 * would opt every run out of the shared budget. The per-run grant is the
 * fallback for daemons that could not arm the FIFO, and never overrides a
 * caller's own `-j` flag or `CARGO_BUILD_JOBS`. Uniform for all callers, so
 * it never fragments intent identity.
 */
export const cargoExecEnv = (
  jobsGrant: number,
  input: Pick<SubmitInput, 'argv' | 'env'>,
  jobserverArmed: boolean,
): Readonly<Record<string, string>> | undefined => {
  const grantsJobs =
    !jobserverArmed &&
    jobsGrant > 0 &&
    input.env?.CARGO_BUILD_JOBS === undefined &&
    !input.argv.some(pinsJobs);
  return grantsJobs ? { ...input.env, CARGO_BUILD_JOBS: String(jobsGrant) } : input.env;
};

export interface LaneRuntimeDeps {
  readonly config: DaemonConfigShape;
  readonly ledger: LedgerApi;
  readonly costModel: CostModelApi;
  readonly topology: TopologyApi;
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner['Service'];
  readonly directory: TicketDirectory;
  readonly daemonScope: Scope;
}

export interface LaneRuntime {
  readonly attachments: AttachmentRuntime;
  readonly getOrCreateLane: (
    key: string,
    workspaceRoot: string,
    targetDir: string,
  ) => Effect.Effect<Lane>;
  readonly makeJob: (
    id: number,
    ticket: string,
    laneKey: string,
    input: SubmitInput,
    intent: NormalizedCargoIntent,
    callbacks: SubmitCallbacks,
    queuedAtMs: number,
    estimate: CostEstimate,
  ) => Effect.Effect<Job>;
  readonly enqueueJob: (lane: Lane, job: Job) => Effect.Effect<number>;
  readonly settleInterruptedJob: (job: Job) => Effect.Effect<void>;
  readonly laneStatuses: () => Effect.Effect<readonly LaneStatus[]>;
  readonly requestStatusFields: (
    ticket: string,
    atMs: number,
  ) => Effect.Effect<{
    readonly queue?: QueueContext;
    readonly delayed?: true;
    readonly quietMs?: number;
    readonly admissionHold?: AdmissionHold;
    readonly stall?: StallReport;
    readonly orphaned?: true;
  }>;
  readonly interruptWorkers: () => Effect.Effect<void>;
  /** Heavy-cap state for status; null when the cap is disabled. */
  readonly heavyAdmission: (
    memAvailableBytes: number | null,
  ) => Effect.Effect<HeavyAdmissionReport | null>;
}

export const makeLaneRuntime = (deps: LaneRuntimeDeps): Effect.Effect<LaneRuntime> =>
  Effect.gen(function* () {
    const { config, ledger, costModel, topology, spawner, directory, daemonScope } = deps;

    const admission = yield* Semaphore.make(config.maxConcurrent);
    const admittedCount = yield* Ref.make(0);
    // Heavy leaders claim their slot as the gate admits them, before the
    // permit wait, so two heavies parked on the semaphore cannot both pass.
    const heavyAdmittedCount = yield* Ref.make(0);
    const laneCreation = yield* Semaphore.make(1);
    const lanes = new Map<string, Lane>();
    const laneWorkers = new Set<Fiber.Fiber<never, never>>();

    const attachments = makeAttachmentRuntime({ directory, ledger });

    const recoverDefect = <A>(fallback: A) => (cause: Cause.Cause<never>): Effect.Effect<A> =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.failCause(cause)
        : Effect.logError(`broker dependency failed: ${Cause.pretty(cause)}`).pipe(
            Effect.as(fallback),
          );

    const makeJob = (
      id: number,
      ticket: string,
      laneKey: string,
      input: SubmitInput,
      intent: NormalizedCargoIntent,
      callbacks: SubmitCallbacks,
      queuedAtMs: number,
      estimate: CostEstimate,
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
          estimateMs: estimate.estimateMs,
          estimateSource: estimate.source,
          startedAtMs: null,
          lastOutputAtMs: null,
          admissionHold: null,
          pid: null,
          stall: null,
          ownerGone: false,
          killReason: null,
          editedRecently,
          depClosure,
        };
      });

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
          lane.pending.map((candidate) => scheduleCandidate(candidate, lane.pending, nowMs)),
        );
        return index === -1 ? undefined : lane.pending.splice(index, 1)[0];
      });

    /**
     * Absorbs other queued compatible jobs onto `leader` as batch
     * attachments. Every composite is the leader's argv plus the followers'
     * `-p` flags; test/nextest composites also add `--no-fail-fast`, and
     * admit only followers with the leader's exact test selection (#53).
     *
     * Only `queued` candidates fold: a pending job already in
     * `kill-requested` (disconnect cleanup leaves it in the lane) would
     * otherwise be compiled for nobody and settled `done` instead of `killed`.
     * Folded followers keep their own `mergeStderr`; the composite's channels
     * are forwarded as the leader produced them.
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
              Ref.getUnsafe(candidate.state) !== 'queued' ||
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
            directory.remove(candidate.ticket);
            const candidateAttachment = makeAttachment({
              id: candidate.id,
              ticket: candidate.ticket,
              mode: 'batch',
              input: candidate.input,
              intent: candidate.intent,
              callbacks: candidate.callbacks,
              createdAtMs: candidate.queuedAtMs,
              estimateMs: candidate.estimateMs,
              estimateSource: candidate.estimateSource,
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
            directory.setAttachment(leader, candidateAttachment);
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
              directory.setAttachment(leader, attachment);
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
            case 'nextest':
              leader.execArgv = composeTestFoldArgv(
                leader.execArgv,
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
          estimateSource: attachment.estimateSource,
          tail: attachment.tail,
          attachedAtMs: atMs,
        });
        const reattached = yield* attachments.tryRegisterAttachment(lane.key, revived);
        if (reattached !== null) {
          yield* attachments.completeAttachRegistration(
            reattached.leader,
            revived,
            reattached.mode,
            atMs,
          );
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
          { estimateMs: attachment.estimateMs, source: attachment.estimateSource },
        );
        yield* Effect.sync(() => directory.setLeader(job));
        yield* enqueueJob(lane, job);
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
        yield* Effect.sync(() => directory.remove(job.ticket));
      });

    const claimSettlement = (job: Job): Effect.Effect<boolean> =>
      Ref.modify(job.state, (state): readonly [boolean, JobState] =>
        state === 'finished' ? [false, state] : [true, 'finished'],
      );

    /**
     * The single idempotent settlement path for every claimed leader
     * lifecycle. Once the state claim wins, ledger rows, waiter notification,
     * in-flight cleanup, callbacks, and attachments complete uninterruptibly.
     * Each step is isolated: the claim is spent, so a defect in one (a busy
     * ledger) must not leave the lane held or the followers without an exit.
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
          const step = (label: string, effect: Effect.Effect<void>): Effect.Effect<void> =>
            settlementStep(`${label} (${job.ticket})`, effect);
          const startedAtMs = job.startedAtMs;
          const waitMs = Math.max(0, (startedAtMs ?? atMs) - job.queuedAtMs);
          const runMs = startedAtMs === null ? 0 : Math.max(0, atMs - startedAtMs);
          yield* step(
            'ledger.markFinished',
            ledger.markFinished(job.id, {
              status,
              atMs,
              exitCode,
              signal,
              outputTail: startedAtMs === null ? null : job.tail.toString(),
              error,
              ...diagnosticFinishFields(job.demux?.globalDiagnostics ?? null),
            }),
          );
          yield* step(
            'metrics',
            Metric.update(jobOutcomeMetric, status).pipe(
              Effect.andThen(
                startedAtMs === null ? Effect.void : Metric.update(waitMsSummary, waitMs),
              ),
            ),
          );
          yield* step('notifyWaiters', directory.notifyWaiters(job.ticket));
          yield* step('completeExit', completeExit(job));
          yield* guarded(
            job.callbacks.onExit({
              ticket: job.ticket,
              status,
              exitCode,
              signal,
              waitMs,
              runMs,
              error,
            }),
          );
          yield* step(
            'settleAttachments',
            attachments.settleAttachments(
              attachmentLane === null
                ? null
                : (attachment, reason) => requeueAttachment(attachmentLane, attachment, reason),
              job,
              status,
              exitCode,
              signal,
              error,
              atMs,
            ),
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
          job.lastOutputAtMs = runStartedAtMs;
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
              const won = yield* attachments.notifyAttachmentStarted(attachment, runStartedAtMs);
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
        const execEnv = cargoExecEnv(config.jobsGrant, job.input, isSharedJobserverArmed());
        const result: ExecutionResult = yield* executeCargo({
          argv: job.execArgv,
          cwd: job.input.cwd,
          env: execEnv,
          killSignal: job.killSignal,
          // The broker-side tail (fed by emitChunk) is authoritative: in
          // demux mode the executor's own tail would capture raw JSON.
          tailBytes: 0,
          onSpawn: (pid) =>
            Effect.sync(() => {
              job.pid = pid;
            }),
          onOutput: (channel, data) => attachments.emitChunk(job, channel, data),
          // The JSON demux owns stdout, so a merged pipe is only honoured for
          // runs that stream raw output (`cargo run`, `cargo test`, ...).
          mergeStderr: job.demux === null && job.input.mergeStderr === true,
          ...(job.demux === null
            ? {}
            : { onStdoutLine: (line: string) => attachments.handleStdoutLine(job, line) }),
        }).pipe(
          Effect.withSpan('cargo.exec'),
          Effect.trackDuration(cargoRunMetric),
          Effect.trackDuration(cargoRunByKindMetric(job.intent.subcommand)),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        );
        const finishedAtMs = Date.now();
        // A compile error is still a measured build time; without it a broken
        // build would be re-estimated at the cold-start default on every retry.
        if (result.outcome !== 'killed') {
          yield* costModel.recordOutcome(job.intent.key, finishedAtMs - runStartedAtMs, {
            outcome: result.outcome,
          });
        }
        // A broker-initiated kill (stall auto-kill) names its reason on the
        // job; the executor only knows a signal arrived.
        yield* settleJob(
          lane,
          job,
          result.outcome,
          result.exitCode,
          result.signal,
          result.outcome === 'killed' ? (result.error ?? job.killReason) : result.error,
          finishedAtMs,
        );
      }).pipe(
        Effect.withSpan('job.process', {
          attributes: { ticket: job.ticket, lane: lane.key },
        }),
      );

    // Admission clamp: load, CPU PSI, and soft memory pressure respect the
    // loadMinConcurrent progress floor. Sustained hard memory PSI (avg60 must
    // reach half the hard threshold), low MemAvailable, macOS critical
    // pressure, and the heavy-leader cap bypass that floor. Every arm still
    // shares this bounded wait, so the queue cannot deadlock and gated jobs
    // remain killable.
    const loadGateDeadlineMs = 120_000;
    const gateDisabled =
      config.loadThresholdPerCore === null &&
      config.cpuStallThreshold === null &&
      config.memPressureSoftThreshold === null &&
      config.memPressureHardThreshold === null &&
      config.memAvailableMinBytes === null &&
      config.memPressureLevelThreshold === null &&
      config.heavyMemAvailableBytes === null;
    const sampleMemAvailable =
      config.memAvailableMinBytes !== null || config.heavyMemAvailableBytes !== null;

    const sampleAdmissionInput = (running: number, heavy: boolean): AdmissionLoadInput => {
      const memPsi =
        config.memPressureSoftThreshold === null && config.memPressureHardThreshold === null
          ? null
          : memoryPsi();
      return {
        cpuStallPercent: config.cpuStallThreshold === null ? null : cpuSomeAvg10(),
        cpuStallThreshold: config.cpuStallThreshold,
        heavy,
        heavyMaxConcurrent: config.heavyMaxConcurrent,
        heavyMemAvailableBytes: config.heavyMemAvailableBytes,
        loadPerCore: loadavg()[0] / availableParallelism(),
        memAvailableBytes: sampleMemAvailable ? memoryAvailableBytes() : null,
        memAvailableMinBytes: config.memAvailableMinBytes,
        memFullAvg10: memPsi?.fullAvg10 ?? null,
        memFullAvg60: memPsi?.fullAvg60 ?? null,
        memHardThreshold: config.memPressureHardThreshold,
        memPressureLevel:
          config.memPressureLevelThreshold === null ? null : memoryPressureLevel(),
        memPressureLevelThreshold: config.memPressureLevelThreshold,
        memSoftThreshold: config.memPressureSoftThreshold,
        minConcurrent: config.loadMinConcurrent,
        running,
        // A disabled loadavg arm never trips; PSI can gate on its own.
        thresholdPerCore: config.loadThresholdPerCore ?? Number.POSITIVE_INFINITY,
      };
    };

    const claimHeavy = Ref.update(heavyAdmittedCount, (count) => count + 1);
    const releaseHeavy = Ref.update(heavyAdmittedCount, (count) => count - 1);
    const heavyLeader = (job: Job): boolean =>
      config.heavyMemAvailableBytes !== null && isHeavyIntent(job.intent);

    /**
     * Resolves once every admission arm clears or the bounded deadline
     * passes. A heavy leader returns holding its heavy slot, claimed in the
     * same atomic step as the decision and recorded in `claimed` so the
     * caller's finalizer releases it even if the fiber is interrupted between
     * this wait and the permit acquisition.
     */
    const waitForLoadHeadroom = (
      job: Job,
      heavy: boolean,
      claimed: { value: boolean },
    ): Effect.Effect<void> =>
      gateDisabled
        ? Effect.void
        : Effect.gen(function* () {
            const deadline = Date.now() + loadGateDeadlineMs;
            while (Date.now() < deadline) {
              const running = yield* Ref.get(admittedCount);
              const sample = yield* Effect.sync(() => sampleAdmissionInput(running, heavy));
              const { decision, input } = yield* Ref.modify(heavyAdmittedCount, (heavyRunning) => {
                const input: AdmissionLoadInput = { ...sample, heavyRunning };
                const decision = admissionDecision(input);
                const claim = !decision.defer && heavy;
                claimed.value = claim;
                return [{ decision, input }, claim ? heavyRunning + 1 : heavyRunning] as const;
              });
              if (!decision.defer) {
                yield* Effect.sync(() => {
                  job.admissionHold = null;
                });
                return;
              }
              const hold = admissionHoldFor(input, decision.reason);
              yield* Effect.sync(() => {
                job.admissionHold = hold;
              });
              yield* Effect.logDebug(
                `admission deferred (${hold.reason}): ${hold.detail}; load/core ${input.loadPerCore.toFixed(2)}, cpu stall ${input.cpuStallPercent?.toFixed(1) ?? 'n/a'}%, memory full avg10 ${input.memFullAvg10?.toFixed(1) ?? 'n/a'}%, avg60 ${input.memFullAvg60?.toFixed(1) ?? 'n/a'}%, available ${input.memAvailableBytes ?? 'n/a'} bytes, macOS level ${input.memPressureLevel ?? 'n/a'} with ${running} running (${input.heavyRunning ?? 0} heavy)`,
              );
              yield* Effect.sleep('2 seconds');
            }
            yield* Effect.sync(() => {
              job.admissionHold = null;
            });
            if (heavy) {
              yield* claimHeavy;
              claimed.value = true;
            }
          });

    /**
     * Resolves once a kill lands on a job that has not started. A kill that
     * arrives after `claimStart` belongs to the run — the executor races the
     * same signal — so this arm parks forever rather than interrupting an
     * admitted run.
     */
    const killedBeforeStart = (job: Job): Effect.Effect<void> =>
      Deferred.await(job.killSignal).pipe(
        Effect.andThen(Ref.get(job.state)),
        Effect.flatMap((state) => (state === 'kill-requested' ? Effect.void : Effect.never)),
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
        const heavy = heavyLeader(job);
        const claimed = { value: false };
        const admitAndRun = waitForLoadHeadroom(job, heavy, claimed).pipe(
          Effect.andThen(
            admission.withPermits(1)(
              Ref.update(admittedCount, (count) => count + 1).pipe(
                Effect.andThen(runAdmitted(lane, job)),
                Effect.ensuring(Ref.update(admittedCount, (count) => count - 1)),
              ),
            ),
          ),
        );
        // A job parked at the load gate or on the permit can wait minutes
        // (and blocks its whole lane); a kill must settle it right away
        // instead of waiting for a permit it will never use.
        yield* Effect.raceFirst(
          admitAndRun,
          killedBeforeStart(job).pipe(Effect.andThen(finishKilledBeforeRun(lane, job))),
        ).pipe(
          Effect.ensuring(Effect.suspend(() => (claimed.value ? releaseHeavy : Effect.void))),
        );
      }).pipe(Effect.onInterrupt(() => settleInterruptedJob(job)));

    const stillQueued = (job: Job): Effect.Effect<boolean> =>
      Ref.get(job.state).pipe(Effect.map((state) => state === 'queued'));

    const processLaneJob = (lane: Lane, job: Job): Effect.Effect<void> =>
      Effect.gen(function* () {
        // A kill-requested head neither waits for nor leads a batch: it
        // would fold followers only to requeue them one by one.
        if (
          config.batchEnabled &&
          config.batchWindowMs > 0 &&
          lane.pending.length === 0 &&
          batchKindFor(job.intent) !== null &&
          (yield* stillQueued(job))
        ) {
          yield* Effect.sleep(`${config.batchWindowMs} millis`);
        }
        if (yield* stillQueued(job)) {
          yield* foldBatch(lane, job);
        }
        yield* processJob(lane, job);
      }).pipe(
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterruptsOnly(cause),
          (cause) => {
            const message = Cause.pretty(cause);
            return Effect.logError(`lane ${lane.key} job ${job.ticket} crashed`, cause).pipe(
              Effect.andThen(
                settleJob(lane, job, 'failed', null, null, message, Date.now()).pipe(
                  Effect.ignore,
                ),
              ),
            );
          },
        ),
      );

    const drainLane = (lane: Lane): Effect.Effect<void> =>
      Effect.gen(function* () {
        while (true) {
          const job = yield* takeNextJob(lane);
          if (job === undefined) {
            return;
          }
          yield* Effect.sync(() => {
            lane.head = job;
          });
          yield* processLaneJob(lane, job).pipe(
            Effect.annotateLogs({ ticket: job.ticket, lane: lane.key }),
            Effect.ensuring(
              Effect.sync(() => {
                if (lane.head === job) {
                  lane.head = null;
                }
              }),
            ),
          );
        }
      });

    const laneWorker = (lane: Lane): Effect.Effect<never> =>
      Effect.forever(
        Queue.take(lane.wake).pipe(
          Effect.andThen(drainLane(lane)),
          Effect.catchCauseIf(
            (cause) => !Cause.hasInterruptsOnly(cause),
            (cause) => Effect.logError(`lane ${lane.key} iteration crashed`, cause),
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
            head: null,
          };
          lanes.set(key, lane);
          const worker = yield* Effect.forkIn(laneWorker(lane), daemonScope);
          yield* Effect.sync(() => laneWorkers.add(worker));
          return lane;
        }),
      );

    const laneStatuses = (): Effect.Effect<readonly LaneStatus[]> =>
      Effect.sync(() =>
        [...lanes.values()].map((lane) => ({
          key: lane.key,
          workspaceRoot: lane.workspaceRoot,
          targetDir: lane.targetDir,
          queued: lane.pending.length,
          runningTicket: lane.running,
        })),
      );

    function scheduleCandidate(
      candidate: Job,
      pending: readonly Job[],
      nowMs: number,
    ) {
      let unblocks = 0;
      if (candidate.intent.packages.length > 0) {
        for (const other of pending) {
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
    }

    const orderedPending = (lane: Lane, nowMs: number): readonly Job[] => {
      const remaining = [...lane.pending];
      const ordered: Job[] = [];
      while (remaining.length > 0) {
        const index = selectNextIndex(
          remaining.map((candidate) => scheduleCandidate(candidate, remaining, nowMs)),
        );
        if (index === -1) {
          break;
        }
        const next = remaining.splice(index, 1)[0];
        if (next !== undefined) {
          ordered.push(next);
        }
      }
      return ordered;
    };

    const requestStatusFields: LaneRuntime['requestStatusFields'] = (ticket, atMs) =>
      Effect.sync(() => {
        const entry = directory.get(ticket);
        if (entry === undefined) {
          return {};
        }
        const leader = entry.kind === 'leader' ? entry.job : entry.leader;
        if (leader.startedAtMs !== null) {
          const quietMs = quietMsSinceOutput(leader.lastOutputAtMs, atMs);
          // Riders share the leader's process, so its stall is theirs too;
          // orphaning is per ticket (only the leader's owner is tracked).
          return {
            ...(quietMs === undefined ? {} : { quietMs }),
            ...(leader.stall === null ? {} : { stall: leader.stall }),
            ...(entry.kind === 'leader' && entry.job.ownerGone ? { orphaned: true } : {}),
          };
        }

        const ownCreatedAtMs =
          entry.kind === 'leader' ? entry.job.queuedAtMs : entry.attachment.createdAtMs;
        const ownEstimateMs =
          entry.kind === 'leader' ? entry.job.estimateMs : entry.attachment.estimateMs;
        const delayed = queuedWaitIsDelayed(Math.max(0, atMs - ownCreatedAtMs), ownEstimateMs);
        // A lane head parked at the admission gate is neither pending nor running.
        const held =
          leader.admissionHold === null ? {} : { admissionHold: leader.admissionHold };
        const lane = lanes.get(leader.laneKey);
        if (lane === undefined) {
          return delayed ? { delayed: true, ...held } : held;
        }
        const pending = orderedPending(lane, atMs);
        const targetIndex = pending.indexOf(leader);
        if (targetIndex === -1) {
          return delayed ? { delayed: true, ...held } : held;
        }

        const ahead = pending.slice(0, targetIndex);
        let waitEtaMs = ahead.reduce((total, job) => total + job.estimateMs, 0);
        const aheadTickets = ahead.map((job) => job.ticket);
        let position = ahead.length;
        let headFields: Partial<QueueContext> = {};
        // The lane head — running, or parked at the gate before its permit —
        // runs before everything pending. An overrunning head contributes
        // zero remaining time, never a negative that cancels queued work.
        const head = lane.head;
        if (head !== null && head !== leader && Ref.getUnsafe(head.state) !== 'finished') {
          aheadTickets.unshift(head.ticket);
          position += 1;
          waitEtaMs += remainingEstimateMs(head, atMs);
          headFields = {
            ...(head.startedAtMs === null
              ? {}
              : { headElapsedMs: Math.max(0, atMs - head.startedAtMs) }),
            headEstimateMs: head.estimateMs,
            headTicket: head.ticket,
          };
        }
        const queue: QueueContext = {
          aheadTickets,
          position,
          waitEtaMs: Math.max(0, waitEtaMs),
          ...headFields,
        };
        return delayed ? { delayed: true, queue } : { queue };
      });

    const interruptWorkers = (): Effect.Effect<void> =>
      Effect.gen(function* () {
        const workers = yield* Effect.sync(() => [...laneWorkers]);
        yield* Effect.forEach(workers, Fiber.interrupt, {
          concurrency: 'unbounded',
          discard: true,
        });
        yield* Effect.sync(() => laneWorkers.clear());
      });

    const heavyAdmission: LaneRuntime['heavyAdmission'] = (memAvailableBytes) =>
      config.heavyMemAvailableBytes === null
        ? Effect.succeed(null)
        : Ref.get(heavyAdmittedCount).pipe(
            Effect.map((running) => ({
              running,
              maxConcurrent: config.heavyMaxConcurrent,
              capActive: heavyCapActive({
                heavyMemAvailableBytes: config.heavyMemAvailableBytes,
                memAvailableBytes,
              }),
            })),
          );

    return {
      attachments,
      getOrCreateLane,
      makeJob,
      enqueueJob,
      settleInterruptedJob,
      laneStatuses,
      requestStatusFields,
      interruptWorkers,
      heavyAdmission,
    } satisfies LaneRuntime;
  });
