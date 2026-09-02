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
  composeNextestBatchArgv,
  composeTestBatchArgv,
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
import type { CostModelApi } from './cost.js';
import { executeCargo, TailBuffer } from './executor.js';
import type { ExecutionResult } from './executor.js';
import type { NormalizedCargoIntent } from './intent-normalizer.js';
import {
  diagnosticFinishFields,
  diagnosticsForAttachment,
  guarded,
  makeAttachment,
  planDemux,
} from './job-state.js';
import type { Attachment, Job, JobState, SubmitCallbacks, SubmitInput } from './job-state.js';
import type { LedgerApi } from './ledger.js';
import {
  cpuSomeAvg10,
  memoryAvailableBytes,
  memoryPressureLevel,
  memoryPsi,
} from './pressure.js';
import type { FinishedStatus, LaneStatus } from './protocol.js';
import { ReplayBuffer } from './replay.js';
import { selectNextIndex, shouldDeferAdmission } from './scheduler.js';
import type { TicketDirectory } from './ticket-directory.js';
import type { TopologyApi } from './topology.js';

/**
 * The lane execution state machine: one FIFO worker per (workspace root,
 * target dir), schedule-scored job selection, batch folding, admission
 * gating, cargo execution, and the single idempotent settlement path.
 */

export interface Lane {
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
    estimateMs: number,
  ) => Effect.Effect<Job>;
  readonly enqueueJob: (lane: Lane, job: Job) => Effect.Effect<number>;
  readonly settleInterruptedJob: (job: Job) => Effect.Effect<void>;
  readonly laneStatuses: () => Effect.Effect<readonly LaneStatus[]>;
  readonly interruptWorkers: () => Effect.Effect<void>;
}

export const makeLaneRuntime = (deps: LaneRuntimeDeps): Effect.Effect<LaneRuntime> =>
  Effect.gen(function* () {
    const { config, ledger, costModel, topology, spawner, directory, daemonScope } = deps;

    const admission = yield* Semaphore.make(config.maxConcurrent);
    const admittedCount = yield* Ref.make(0);
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
          attachment.estimateMs,
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
          const waitMs = Math.max(0, (startedAtMs ?? atMs) - job.queuedAtMs);
          const runMs = startedAtMs === null ? 0 : Math.max(0, atMs - startedAtMs);
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
          if (startedAtMs !== null) {
            yield* Metric.update(waitMsSummary, waitMs);
          }
          yield* directory.notifyWaiters(job.ticket);
          yield* completeExit(job);
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
          yield* attachments.settleAttachments(
            attachmentLane === null
              ? null
              : (attachment, reason) => requeueAttachment(attachmentLane, attachment, reason),
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
          onOutput: (channel, data) => attachments.emitChunk(job, channel, data),
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

    // Admission clamp: load, CPU PSI, and soft memory pressure respect the
    // loadMinConcurrent progress floor. Sustained hard memory PSI (avg60 must
    // reach half the hard threshold), low MemAvailable, and macOS critical
    // pressure bypass that floor. Every arm still shares this bounded wait,
    // so the queue cannot deadlock and gated jobs remain killable.
    const loadGateDeadlineMs = 120_000;
    const waitForLoadHeadroom: Effect.Effect<void> =
      config.loadThresholdPerCore === null &&
      config.cpuStallThreshold === null &&
      config.memPressureSoftThreshold === null &&
      config.memPressureHardThreshold === null &&
      config.memAvailableMinBytes === null &&
      config.memPressureLevelThreshold === null
        ? Effect.void
        : Effect.gen(function* () {
            // A disabled loadavg arm never trips; PSI can gate on its own.
            const thresholdPerCore = config.loadThresholdPerCore ?? Number.POSITIVE_INFINITY;
            const deadline = Date.now() + loadGateDeadlineMs;
            while (Date.now() < deadline) {
              const running = yield* Ref.get(admittedCount);
              const loadPerCore = loadavg()[0] / availableParallelism();
              const cpuStallPercent = config.cpuStallThreshold === null ? null : cpuSomeAvg10();
              const memPsi =
                config.memPressureSoftThreshold === null &&
                config.memPressureHardThreshold === null
                  ? null
                  : memoryPsi();
              const memAvailable =
                config.memAvailableMinBytes === null ? null : memoryAvailableBytes();
              const memLevel =
                config.memPressureLevelThreshold === null ? null : memoryPressureLevel();
              if (
                !shouldDeferAdmission({
                  cpuStallPercent,
                  cpuStallThreshold: config.cpuStallThreshold,
                  loadPerCore,
                  memAvailableBytes: memAvailable,
                  memAvailableMinBytes: config.memAvailableMinBytes,
                  memFullAvg10: memPsi?.fullAvg10 ?? null,
                  memFullAvg60: memPsi?.fullAvg60 ?? null,
                  memHardThreshold: config.memPressureHardThreshold,
                  memPressureLevel: memLevel,
                  memPressureLevelThreshold: config.memPressureLevelThreshold,
                  memSoftThreshold: config.memPressureSoftThreshold,
                  minConcurrent: config.loadMinConcurrent,
                  running,
                  thresholdPerCore,
                })
              ) {
                return;
              }
              yield* Effect.logDebug(
                `admission deferred: load/core ${loadPerCore.toFixed(2)} (threshold ${thresholdPerCore}), cpu stall ${cpuStallPercent?.toFixed(1) ?? 'n/a'}% (threshold ${config.cpuStallThreshold ?? 'off'}), memory full avg10 ${memPsi?.fullAvg10.toFixed(1) ?? 'n/a'}%, avg60 ${memPsi?.fullAvg60.toFixed(1) ?? 'n/a'}%, available ${memAvailable ?? 'n/a'} bytes, macOS level ${memLevel ?? 'n/a'} with ${running} running`,
              );
              yield* Effect.sleep('2 seconds');
            }
          });

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
        yield* waitForLoadHeadroom;
        yield* admission.withPermits(1)(
          Ref.update(admittedCount, (count) => count + 1).pipe(
            Effect.andThen(runAdmitted(lane, job)),
            Effect.ensuring(Ref.update(admittedCount, (count) => count - 1)),
          ),
        );
      }).pipe(Effect.onInterrupt(() => settleInterruptedJob(job)));

    const processLaneJob = (lane: Lane, job: Job): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (
          config.batchEnabled &&
          config.batchWindowMs > 0 &&
          lane.pending.length === 0 &&
          batchKindFor(job.intent) !== null
        ) {
          yield* Effect.sleep(`${config.batchWindowMs} millis`);
        }
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

    const interruptWorkers = (): Effect.Effect<void> =>
      Effect.gen(function* () {
        const workers = yield* Effect.sync(() => [...laneWorkers]);
        yield* Effect.forEach(workers, Fiber.interrupt, {
          concurrency: 'unbounded',
          discard: true,
        });
        yield* Effect.sync(() => laneWorkers.clear());
      });

    return {
      attachments,
      getOrCreateLane,
      makeJob,
      enqueueJob,
      settleInterruptedJob,
      laneStatuses,
      interruptWorkers,
    } satisfies LaneRuntime;
  });
