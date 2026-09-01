import * as CommandExecutor from '@effect/platform/CommandExecutor';
import * as Cause from 'effect/Cause';
import * as Context from 'effect/Context';
import * as Data from 'effect/Data';
import * as Deferred from 'effect/Deferred';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Queue from 'effect/Queue';
import * as Ref from 'effect/Ref';

import { DaemonConfig } from './config.js';
import { attachModeFor } from './coverage.js';
import { executeCargo } from './executor.js';
import type { ExecutionResult } from './executor.js';
import { normalizeCargoIntent } from './intent-normalizer.js';
import type { NormalizedCargoIntent } from './intent-normalizer.js';
import { Ledger } from './ledger.js';
import type { LedgerApi } from './ledger.js';
import type { AttachMode, FinishedStatus, LaneStatus, StatusReport } from './protocol.js';
import { ReplayBuffer } from './replay.js';
import type { ReplayChunk } from './replay.js';
import { findConfiguredTargetDir, locateWorkspaceRoot } from './workspace.js';

export interface SubmitInput {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly workspaceRoot?: string | undefined;
  readonly env?: Readonly<Record<string, string>> | undefined;
  readonly session?: string | undefined;
  readonly host?: string | undefined;
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
}

export interface KillOptions {
  readonly onlyIfQueued?: boolean;
}

export class CargoIntentError extends Data.TaggedError('CargoIntentError')<{
  readonly message: string;
}> {}

export interface BrokerApi {
  readonly submit: (
    input: SubmitInput,
    callbacks: SubmitCallbacks,
  ) => Effect.Effect<SubmitResult, CargoIntentError>;
  readonly kill: (ticket: string, options?: KillOptions) => Effect.Effect<boolean>;
  readonly report: (recentLimit?: number) => Effect.Effect<StatusReport>;
}

export class Broker extends Context.Tag('cargo-conductor/Broker')<Broker, BrokerApi>() {}

type JobState = 'queued' | 'running' | 'finished';

interface Attachment {
  readonly id: number;
  readonly ticket: string;
  /** Assigned by tryRegisterAttachment in the same frame that registers it. */
  mode: AttachMode;
  readonly input: SubmitInput;
  readonly intent: NormalizedCargoIntent;
  readonly callbacks: SubmitCallbacks;
  readonly createdAtMs: number;
  attachedAtMs: number;
  /** True once the replay backlog is flushed; live output then flows directly. */
  live: boolean;
  startNotified: boolean;
  readonly pendingLive: ReplayChunk[];
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
}

type InFlightEntry =
  | { readonly kind: 'leader'; readonly job: Job }
  | { readonly kind: 'attachment'; readonly leader: Job; readonly attachment: Attachment };

interface Lane {
  readonly key: string;
  readonly workspaceRoot: string;
  readonly targetDir: string;
  readonly queue: Queue.Queue<Job>;
  readonly running: Ref.Ref<string | null>;
}

/** Lane identity: one FIFO per (workspace root, resolved cargo target dir). */
export const laneKeyFor = (workspaceRoot: string, targetDir: string): string =>
  JSON.stringify([workspaceRoot, targetDir]);

const invalidLaneKey = 'invalid';

const guarded = (effect: Effect.Effect<void>): Effect.Effect<void> =>
  Effect.catchAllCause(effect, () => Effect.void);

const requeueReasonFor = (mode: AttachMode, status: FinishedStatus): string =>
  mode === 'coverage'
    ? `covering ${status === 'killed' ? 'run was killed' : 'run failed'}; running your request directly`
    : 'coalesced run was killed; running your request directly';

export const BrokerLive: Layer.Layer<
  Broker,
  never,
  DaemonConfig | Ledger | CommandExecutor.CommandExecutor
> = Layer.scoped(
  Broker,
  Effect.gen(function* () {
    const config = yield* DaemonConfig;
    const ledger = yield* Ledger;
    const commandExecutor = yield* CommandExecutor.CommandExecutor;
    const daemonScope = yield* Effect.scope;
    const startedAtMs = Date.now();

    const admission = yield* Effect.makeSemaphore(config.maxConcurrent);
    const laneCreation = yield* Effect.makeSemaphore(1);
    const lanes = new Map<string, Lane>();
    const inFlight = new Map<string, InFlightEntry>();

    /** Fan one output chunk to the leader, the replay buffer, and every live attachment. */
    const emitOutput = (
      job: Job,
      channel: 'stdout' | 'stderr',
      data: Uint8Array,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const liveAttachments = yield* Effect.sync(() => {
          job.replay.push(channel, data);
          const live: Attachment[] = [];
          for (const attachment of job.attachments.values()) {
            if (attachment.live) {
              live.push(attachment);
            } else {
              attachment.pendingLive.push({ channel, data: Buffer.from(data) });
            }
          }
          return live;
        });
        yield* guarded(job.callbacks.onOutput({ ticket: job.ticket, channel, data }));
        yield* Effect.forEach(
          liveAttachments,
          (attachment) =>
            guarded(
              attachment.callbacks.onOutput({ ticket: attachment.ticket, channel, data }),
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
          guarded(
            attachment.callbacks.onOutput({
              ticket: attachment.ticket,
              channel: chunk.channel,
              data: chunk.data,
            }),
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
          yield* guarded(
            attachment.callbacks.onOutput({
              ticket: attachment.ticket,
              channel: 'stderr',
              data: Buffer.from(
                `[cargo-conductor] replay truncated: ${snapshot.droppedBytes} earlier output bytes dropped\n`,
              ),
            }),
          );
        }
        yield* emitChunks(attachment, snapshot.chunks);
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
      outputTail: string | null,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        yield* ledger.markFinished(attachment.id, {
          status: exit.status,
          atMs,
          exitCode: exit.exitCode,
          signal: exit.signal,
          outputTail,
          error: exit.error,
        });
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
            waitMs: Math.max(0, attachment.attachedAtMs - attachment.createdAtMs),
            runMs: Math.max(0, atMs - attachment.attachedAtMs),
            error: exit.error,
          }),
        );
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
    ): Effect.Effect<Job> =>
      Effect.gen(function* () {
        const killSignal = yield* Deferred.make<void>();
        const state = yield* Ref.make<JobState>('queued');
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
        };
      });

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
        yield* ledger.markRequeued(attachment.id, atMs);
        const onRequeued = attachment.callbacks.onRequeued;
        if (onRequeued !== undefined) {
          yield* guarded(onRequeued({ ticket: attachment.ticket, reason }));
        }
        const revived: Attachment = {
          id: attachment.id,
          ticket: attachment.ticket,
          mode: attachment.mode,
          input: attachment.input,
          intent: attachment.intent,
          callbacks: attachment.callbacks,
          createdAtMs: attachment.createdAtMs,
          attachedAtMs: atMs,
          live: false,
          startNotified: false,
          pendingLive: [],
        };
        const reattached = yield* tryRegisterAttachment(lane.key, revived);
        if (reattached !== null) {
          yield* ledger.markAttached(attachment.id, {
            atMs,
            leaderTicket: reattached.leader.ticket,
            mode: reattached.mode,
          });
          const leaderState = yield* Ref.get(reattached.leader.state);
          if (leaderState === 'running') {
            const won = yield* notifyAttachmentStarted(revived, atMs);
            if (won) {
              yield* replayThenGoLive(reattached.leader, revived);
            }
          }
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
        );
        yield* Effect.sync(() => inFlight.set(job.ticket, { kind: 'leader', job }));
        yield* Queue.offer(lane.queue, job);
      });

    /** Mirrors or requeues every attachment after the leader reached `status`. */
    const settleAttachments = (
      lane: Lane | null,
      job: Job,
      status: FinishedStatus,
      exitCode: number | null,
      signal: string | null,
      error: string | null,
      outputTail: string | null,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const detached = yield* detachAll(job);
        if (detached.length === 0) {
          return;
        }
        const atMs = Date.now();
        for (const attachment of detached) {
          const mirrors =
            status === 'done' || (status === 'failed' && attachment.mode === 'identity');
          if (mirrors) {
            yield* notifyAttachmentStarted(attachment, atMs);
            yield* finishAttachment(
              attachment,
              atMs,
              { status, exitCode, signal, error },
              outputTail,
            );
          } else if (lane !== null) {
            yield* requeueAttachment(lane, attachment, requeueReasonFor(attachment.mode, status));
          } else {
            yield* finishAttachment(
              attachment,
              atMs,
              { status: 'killed', exitCode: null, signal: null, error: 'daemon shutdown' },
              null,
            );
          }
        }
      });

    const finishExit = (lane: Lane | null, job: Job): Effect.Effect<void> =>
      Effect.gen(function* () {
        yield* Ref.set(job.state, 'finished');
        if (lane !== null) {
          yield* Ref.update(lane.running, (current) => (current === job.ticket ? null : current));
        }
        yield* Effect.sync(() => inFlight.delete(job.ticket));
      });

    const finishKilledBeforeRun = (lane: Lane, job: Job): Effect.Effect<void> =>
      Effect.gen(function* () {
        const atMs = Date.now();
        yield* ledger.markFinished(job.id, {
          status: 'killed',
          atMs,
          error: 'killed while queued',
        });
        yield* finishExit(lane, job);
        yield* guarded(
          job.callbacks.onExit({
            ticket: job.ticket,
            status: 'killed',
            exitCode: null,
            signal: null,
            waitMs: atMs - job.queuedAtMs,
            runMs: 0,
            error: 'killed while queued',
          }),
        );
        yield* settleAttachments(lane, job, 'killed', null, null, 'killed while queued', null);
      });

    // Runs with an admission permit held; interruption here means daemon
    // shutdown, so the ledger row is closed out while the db is still open.
    const runAdmitted = (lane: Lane, job: Job): Effect.Effect<void> =>
      Effect.gen(function* () {
        const killedBeforeStart = yield* Deferred.isDone(job.killSignal);
        if (killedBeforeStart) {
          yield* finishKilledBeforeRun(lane, job);
          return;
        }
        const runStartedAtMs = Date.now();
        yield* Ref.set(job.state, 'running');
        yield* Ref.set(lane.running, job.ticket);
        yield* ledger.markRunning(job.id, runStartedAtMs);
        const waitMs = runStartedAtMs - job.queuedAtMs;
        yield* guarded(job.callbacks.onStarted({ ticket: job.ticket, waitMs }));
        const queuedAttachments = yield* Effect.sync(() => [...job.attachments.values()]);
        yield* Effect.forEach(
          queuedAttachments,
          (attachment) =>
            Effect.gen(function* () {
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
        const result: ExecutionResult = yield* executeCargo({
          argv: job.input.argv,
          cwd: job.input.cwd,
          env: job.input.env,
          killSignal: job.killSignal,
          tailBytes: config.outputTailBytes,
          onOutput: (channel, data) => emitOutput(job, channel, data),
        }).pipe(
          Effect.provideService(CommandExecutor.CommandExecutor, commandExecutor),
          Effect.onInterrupt(() =>
            ledger
              .markFinished(job.id, {
                status: 'killed',
                atMs: Date.now(),
                signal: 'SIGTERM',
                error: 'daemon shutdown',
              })
              .pipe(
                Effect.zipRight(finishExit(lane, job)),
                Effect.zipRight(
                  settleAttachments(null, job, 'killed', null, 'SIGTERM', 'daemon shutdown', null),
                ),
                Effect.ignore,
              ),
          ),
        );
        const finishedAtMs = Date.now();
        yield* ledger.markFinished(job.id, {
          status: result.outcome,
          atMs: finishedAtMs,
          exitCode: result.exitCode,
          signal: result.signal,
          outputTail: result.outputTail,
          error: result.error,
        });
        yield* finishExit(lane, job);
        yield* guarded(
          job.callbacks.onExit({
            ticket: job.ticket,
            status: result.outcome,
            exitCode: result.exitCode,
            signal: result.signal,
            waitMs,
            runMs: finishedAtMs - runStartedAtMs,
            error: result.error,
          }),
        );
        yield* settleAttachments(
          lane,
          job,
          result.outcome,
          result.exitCode,
          result.signal,
          result.error,
          result.outputTail,
        );
      });

    const processJob = (lane: Lane, job: Job): Effect.Effect<void> =>
      Effect.gen(function* () {
        const killedWhileQueued = yield* Deferred.isDone(job.killSignal);
        if (killedWhileQueued) {
          yield* finishKilledBeforeRun(lane, job);
          return;
        }
        yield* admission.withPermits(1)(runAdmitted(lane, job));
      });

    const laneWorker = (lane: Lane): Effect.Effect<never> =>
      Effect.forever(
        Effect.gen(function* () {
          const job = yield* Queue.take(lane.queue);
          yield* processJob(lane, job).pipe(
            Effect.catchAllCause((cause) =>
              Effect.gen(function* () {
                const message = Cause.pretty(cause);
                yield* Effect.logError(`lane ${lane.key} job ${job.ticket} crashed: ${message}`);
                yield* ledger
                  .markFinished(job.id, {
                    status: 'failed',
                    atMs: Date.now(),
                    error: message,
                  })
                  .pipe(Effect.ignore);
                yield* finishExit(lane, job);
                yield* settleAttachments(lane, job, 'failed', null, null, message, null).pipe(
                  Effect.ignore,
                );
              }),
            ),
          );
        }),
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
          const queue = yield* Queue.unbounded<Job>();
          const running = yield* Ref.make<string | null>(null);
          const lane: Lane = { key, workspaceRoot, targetDir, queue, running };
          lanes.set(key, lane);
          yield* Effect.forkIn(laneWorker(lane), daemonScope);
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
    const submit = (
      input: SubmitInput,
      callbacks: SubmitCallbacks,
    ): Effect.Effect<SubmitResult, CargoIntentError> =>
      Effect.gen(function* () {
        const createdAtMs = Date.now();
        const workspaceRoot = yield* Effect.sync(
          () => input.workspaceRoot ?? locateWorkspaceRoot(input.cwd),
        );
        const normalized = yield* Effect.try({
          try: () =>
            normalizeCargoIntent({
              argv: input.argv,
              cwd: input.cwd,
              env: input.env ?? {},
              workspaceRoot,
              configuredTargetDir: findConfiguredTargetDir(input.cwd, workspaceRoot),
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
            });
            const attachment: Attachment = {
              id: created.id,
              ticket: created.ticket,
              mode: 'identity',
              input,
              intent: normalized,
              callbacks,
              createdAtMs,
              attachedAtMs: createdAtMs,
              live: false,
              startNotified: false,
              pendingLive: [],
            };
            const registered = yield* tryRegisterAttachment(laneKey, attachment);
            if (registered !== null) {
              const mode = registered.mode;
              yield* ledger.markAttached(created.id, {
                atMs: Date.now(),
                leaderTicket: registered.leader.ticket,
                mode,
              });
              const leaderState = yield* Ref.get(registered.leader.state);
              if (leaderState === 'running') {
                const won = yield* notifyAttachmentStarted(attachment, Date.now());
                if (won) {
                  yield* replayThenGoLive(registered.leader, attachment);
                }
              }
              return {
                ticket: created.ticket,
                laneKey,
                position: 0,
                attachedTo: registered.leader.ticket,
                attachMode: mode,
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
            );
            yield* Effect.sync(() => inFlight.set(job.ticket, { kind: 'leader', job }));
            yield* ledger.markQueued(created.id, createdAtMs);
            const position = yield* Queue.size(lane.queue);
            yield* Queue.offer(lane.queue, job);
            return { ticket: created.ticket, laneKey, position };
          }),
        );
      });

    const killAttachment = (entry: {
      readonly leader: Job;
      readonly attachment: Attachment;
    }): Effect.Effect<boolean> =>
      Effect.gen(function* () {
        const removed = yield* Effect.sync(() => {
          const present = entry.leader.attachments.delete(entry.attachment.ticket);
          inFlight.delete(entry.attachment.ticket);
          return present;
        });
        if (!removed) {
          return false;
        }
        yield* finishAttachment(
          entry.attachment,
          Date.now(),
          { status: 'killed', exitCode: null, signal: null, error: 'detached by kill' },
          null,
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
        const state = yield* Ref.get(job.state);
        if (state === 'finished') {
          return false;
        }
        if (options?.onlyIfQueued === true && state !== 'queued') {
          return false;
        }
        yield* Deferred.succeed(job.killSignal, undefined);
        return true;
      });

    const report = (recentLimit = 50): Effect.Effect<StatusReport> =>
      Effect.gen(function* () {
        const laneStatuses: LaneStatus[] = [];
        for (const lane of lanes.values()) {
          // Queue.size is negative while the lane worker is parked in
          // Queue.take (suspended takers), which is not queued work.
          const queued = Math.max(0, yield* Queue.size(lane.queue));
          const runningTicket = yield* Ref.get(lane.running);
          laneStatuses.push({
            key: lane.key,
            workspaceRoot: lane.workspaceRoot,
            targetDir: lane.targetDir,
            queued,
            runningTicket,
          });
        }
        const active = yield* ledger.activeRequests();
        const recent = yield* ledger.recentRequests(recentLimit);
        return {
          pid: process.pid,
          startedAtMs,
          socketPath: config.socketPath,
          maxConcurrent: config.maxConcurrent,
          lanes: laneStatuses,
          active,
          recent,
        };
      });

    return { submit, kill, report } satisfies BrokerApi;
  }),
);
