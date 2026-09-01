import * as CommandExecutor from '@effect/platform/CommandExecutor';
import * as Cause from 'effect/Cause';
import * as Context from 'effect/Context';
import * as Data from 'effect/Data';
import * as Deferred from 'effect/Deferred';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Queue from 'effect/Queue';
import * as Ref from 'effect/Ref';

import {
  batchCompatible,
  batchLeaderEligible,
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
import type { ReplayChunk } from './replay.js';
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
  /** Cost-model estimate for queued (non-attached) requests. */
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
  readonly kill: (ticket: string, options?: KillOptions) => Effect.Effect<boolean>;
  readonly report: (recentLimit?: number) => Effect.Effect<StatusReport>;
  readonly getTicket: (ticket: string) => Effect.Effect<RequestRecord | null>;
  readonly awaitTicket: (ticket: string, maxWaitMs: number) => Effect.Effect<AwaitTicketResult>;
  readonly sessionPending: (session: string) => Effect.Effect<readonly RequestRecord[]>;
  readonly sessionCompleted: (
    session: string,
    sinceMs: number,
  ) => Effect.Effect<readonly RequestRecord[]>;
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

/** Per-unit completion state accumulated from the cargo JSON message stream. */
interface DemuxState {
  /** Package name -> target kinds with a completed compiler-artifact. */
  readonly unitKinds: Map<string, Set<string>>;
  /** Packages whose lib-shaped unit produced an error-level diagnostic. */
  readonly libErrors: Set<string>;
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
  /** Fail-fast signal captured at submission (topology stat, cached). */
  readonly editedRecently: boolean;
  /** Packages folded in by the batch composer; appended as -p flags at spawn. */
  readonly extraPackages: string[];
}

const demuxSubcommands = new Set(['build', 'check', 'clippy']);

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
    demux: { unitKinds: new Map(), libErrors: new Set() },
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
  /** One token per pending job; wakes the lane worker. */
  readonly wake: Queue.Queue<void>;
  readonly running: Ref.Ref<string | null>;
}

/** Lane identity: one FIFO per (workspace root, resolved cargo target dir). */
export const laneKeyFor = (workspaceRoot: string, targetDir: string): string =>
  JSON.stringify([workspaceRoot, targetDir]);

const invalidLaneKey = 'invalid';

const isTerminalStatus = (status: string): boolean =>
  status === 'done' || status === 'failed' || status === 'killed';

const guarded = (effect: Effect.Effect<void>): Effect.Effect<void> =>
  Effect.catchAllCause(effect, () => Effect.void);

const requeueReasonFor = (mode: AttachMode, status: FinishedStatus): string =>
  mode === 'identity'
    ? 'coalesced run was killed; running your request directly'
    : `${mode === 'batch' ? 'batched' : 'covering'} ${
        status === 'killed' ? 'run was killed' : 'run failed'
      }; running your request directly`;

export const BrokerLive: Layer.Layer<
  Broker,
  never,
  DaemonConfig | Ledger | CostModel | Topology | CommandExecutor.CommandExecutor
> = Layer.scoped(
  Broker,
  Effect.gen(function* () {
    const config = yield* DaemonConfig;
    const ledger = yield* Ledger;
    const costModel = yield* CostModel;
    const topology = yield* Topology;
    const commandExecutor = yield* CommandExecutor.CommandExecutor;
    const daemonScope = yield* Effect.scope;
    const startedAtMs = Date.now();

    const admission = yield* Effect.makeSemaphore(config.maxConcurrent);
    const laneCreation = yield* Effect.makeSemaphore(1);
    const lanes = new Map<string, Lane>();
    const inFlight = new Map<string, InFlightEntry>();
    const ticketWaiters = new Map<string, Deferred.Deferred<RequestRecord>[]>();

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
      coverageFilter: (attachment: Attachment) => boolean = () => true,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const liveAttachments = yield* Effect.sync(() => {
          job.replay.push(channel, data);
          job.tail.push(data);
          const live: Attachment[] = [];
          for (const attachment of job.attachments.values()) {
            if (
              (attachment.mode === 'coverage' || attachment.mode === 'batch') &&
              !coverageFilter(attachment)
            ) {
              continue;
            }
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
        const plan = planDemux(intent, input.argv);
        const estimate = yield* costModel.estimate(intent);
        const editedRecently = yield* topology
          .editedRecently(intent.workspaceRoot, intent.packages)
          .pipe(Effect.catchAllCause(() => Effect.succeed(false)));
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
          editedRecently,
          extraPackages: [],
        };
      });

    /** Push to the lane's pending set and wake the worker (one token per job). */
    const enqueueJob = (lane: Lane, job: Job): Effect.Effect<number> =>
      Effect.gen(function* () {
        const position = yield* Effect.sync(() => {
          lane.pending.push(job);
          return lane.pending.length - 1;
        });
        yield* Queue.offer(lane.wake, undefined);
        return position;
      });

    /** Splices out the best-scored pending job under the scheduling policy. */
    const takeNextJob = (lane: Lane): Effect.Effect<Job | undefined> =>
      Effect.sync(() => {
        const nowMs = Date.now();
        const index = selectNextIndex(
          lane.pending.map((candidate) => ({
            id: candidate.id,
            estimateMs: candidate.estimateMs,
            waiters: candidate.attachments.size,
            ageMs: nowMs - candidate.queuedAtMs,
            editedRecently: candidate.editedRecently,
          })),
        );
        return index === -1 ? undefined : lane.pending.splice(index, 1)[0];
      });

    /**
     * Absorbs other queued compatible check/build/clippy jobs onto `leader`
     * as coverage attachments and expands the leader argv with their `-p`s.
     */
    const foldBatch = (lane: Lane, leader: Job): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (!config.batchEnabled || !batchLeaderEligible(leader.intent)) {
          return;
        }
        const extras: string[] = [];
        const absorbed: Job[] = [];
        yield* Effect.sync(() => {
          const named = new Set(leader.intent.packages);
          for (let index = lane.pending.length - 1; index >= 0; index -= 1) {
            const candidate = lane.pending[index];
            if (candidate === undefined || !batchCompatible(leader.intent, candidate.intent)) {
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
            inFlight.delete(candidate.ticket);
          }
        });
        const atMs = Date.now();
        yield* Effect.forEach(
          absorbed,
          (candidate) =>
            Effect.gen(function* () {
              const attachment: Attachment = {
                id: candidate.id,
                ticket: candidate.ticket,
                mode: 'batch',
                input: candidate.input,
                intent: candidate.intent,
                callbacks: candidate.callbacks,
                createdAtMs: candidate.queuedAtMs,
                attachedAtMs: atMs,
                live: false,
                startNotified: false,
                pendingLive: [],
              };
              yield* Effect.sync(() => {
                leader.attachments.set(attachment.ticket, attachment);
                inFlight.set(attachment.ticket, { kind: 'attachment', leader, attachment });
              });
              yield* ledger.markAttached(candidate.id, {
                atMs,
                leaderTicket: leader.ticket,
                mode: 'batch',
              });
            }),
          { discard: true },
        );
        if (extras.length > 0) {
          yield* Effect.sync(() => {
            leader.execArgv = withExtraPackages(leader.execArgv, extras);
          });
        }
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
        const atMs = Date.now();
        yield* Effect.forEach(
          decided,
          ({ attachment, failed }) =>
            Effect.gen(function* () {
              yield* notifyAttachmentStarted(attachment, atMs);
              yield* guarded(
                attachment.callbacks.onOutput({
                  ticket: attachment.ticket,
                  channel: 'stderr',
                  data: Buffer.from(
                    failed === null
                      ? `[cargo-conductor] released early: requested packages compiled cleanly under ${job.ticket}\n`
                      : `[cargo-conductor] released early: ${failed} failed to compile under ${job.ticket}\n`,
                  ),
                }),
              );
              yield* finishAttachment(
                attachment,
                atMs,
                failed === null
                  ? { status: 'done', exitCode: 0, signal: null, error: null }
                  : {
                      status: 'failed',
                      exitCode: 101,
                      signal: null,
                      error: `compile errors in ${failed}`,
                    },
                job.tail.toString(),
              );
            }),
          { discard: true },
        );
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
        return emitChunk(job, 'stdout', Buffer.from(`${line}\n`), () => false);
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
          }).pipe(Effect.zipRight(releaseSatisfiedAttachments(job)));
        }
        case 'message': {
          const packageName = event.packageName;
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
                  (attachment) =>
                    packageName === null || attachment.intent.packages.includes(packageName),
                );
          return record.pipe(
            Effect.zipRight(forward),
            Effect.zipRight(releaseSatisfiedAttachments(job)),
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
            yield* releaseSatisfiedAttachments(reattached.leader);
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
      outputTail: string | null,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const detached = yield* detachAll(job);
        if (detached.length === 0) {
          return;
        }
        const atMs = Date.now();
        for (const attachment of detached) {
          // A failed leader can still prove a coverage demand: the demanded
          // units may have compiled cleanly before an unrelated unit failed.
          const provenDespiteFailure =
            status === 'failed' &&
            attachment.mode !== 'identity' &&
            job.demux !== null &&
            demandSatisfied(attachment.intent, job.demux);
          const mirrors =
            status === 'done' || (status === 'failed' && attachment.mode === 'identity');
          if (provenDespiteFailure) {
            yield* notifyAttachmentStarted(attachment, atMs);
            yield* guarded(
              attachment.callbacks.onOutput({
                ticket: attachment.ticket,
                channel: 'stderr',
                data: Buffer.from(
                  `[cargo-conductor] ${job.ticket} failed elsewhere, but your requested packages compiled cleanly\n`,
                ),
              }),
            );
            yield* finishAttachment(
              attachment,
              atMs,
              { status: 'done', exitCode: 0, signal: null, error: null },
              outputTail,
            );
          } else if (mirrors) {
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
        yield* notifyWaiters(job.ticket);
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
        const finalArgv =
          job.extraPackages.length === 0
            ? job.execArgv
            : [
                ...job.execArgv,
                ...job.extraPackages.flatMap((name) => ['-p', name]),
              ];
        const result: ExecutionResult = yield* executeCargo({
          argv: finalArgv,
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
        const outputTail = job.tail.toString();
        if (result.outcome === 'done') {
          yield* costModel.recordOutcome(job.intent.key, finishedAtMs - runStartedAtMs);
        }
        yield* ledger.markFinished(job.id, {
          status: result.outcome,
          atMs: finishedAtMs,
          exitCode: result.exitCode,
          signal: result.signal,
          outputTail,
          error: result.error,
        });
        yield* notifyWaiters(job.ticket);
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
          outputTail,
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
          yield* Queue.take(lane.wake);
          const job = yield* takeNextJob(lane);
          if (job === undefined) {
            return;
          }
          yield* foldBatch(lane, job);
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
          const wake = yield* Queue.unbounded<void>();
          const running = yield* Ref.make<string | null>(null);
          const lane: Lane = { key, workspaceRoot, targetDir, pending: [], wake, running };
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
            const holdStop =
              input.holdStop ?? (input.session !== undefined && input.background !== true);
            const estimate = yield* costModel.estimate(normalized);
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
                // The demand may already be proven by units that finished
                // before this attachment arrived.
                yield* releaseSatisfiedAttachments(registered.leader);
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
            const position = yield* enqueueJob(lane, job);
            return { ticket: created.ticket, laneKey, position, etaMs: job.estimateMs };
          }),
        );
      });

    const getTicket = (ticket: string): Effect.Effect<RequestRecord | null> =>
      ledger.getRequestByTicket(ticket);

    const awaitTicket = (ticket: string, maxWaitMs: number): Effect.Effect<AwaitTicketResult> =>
      Effect.gen(function* () {
        const current = yield* ledger.getRequestByTicket(ticket);
        if (current === null) {
          return { record: null, timedOut: false };
        }
        if (isTerminalStatus(current.status)) {
          return { record: current, timedOut: false };
        }
        const waiter = yield* Deferred.make<RequestRecord>();
        yield* Effect.sync(() => {
          const existing = ticketWaiters.get(ticket) ?? [];
          existing.push(waiter);
          ticketWaiters.set(ticket, existing);
        });
        return yield* Deferred.await(waiter).pipe(
          Effect.timeout(`${Math.max(0, maxWaitMs)} millis`),
          Effect.map((record) => ({ record, timedOut: false })),
          Effect.catchTag('TimeoutException', () =>
            Effect.gen(function* () {
              yield* Effect.sync(() => {
                const remaining = (ticketWaiters.get(ticket) ?? []).filter((item) => item !== waiter);
                if (remaining.length === 0) {
                  ticketWaiters.delete(ticket);
                } else {
                  ticketWaiters.set(ticket, remaining);
                }
              });
              const record = yield* ledger.getRequestByTicket(ticket);
              return {
                record,
                timedOut: record === null || !isTerminalStatus(record.status),
              };
            }),
          ),
        );
      });

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
          const queued = lane.pending.length;
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

    return {
      submit,
      kill,
      report,
      getTicket,
      awaitTicket,
      sessionPending,
      sessionCompleted,
    } satisfies BrokerApi;
  }),
);
