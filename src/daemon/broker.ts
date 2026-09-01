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
import { executeCargo } from './executor.js';
import { normalizeCargoIntent } from './intent-normalizer.js';
import { Ledger } from './ledger.js';
import type { LedgerApi } from './ledger.js';
import type { FinishedStatus, LaneStatus, StatusReport } from './protocol.js';
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

/**
 * Callbacks are invoked from lane worker fibers, potentially after the
 * originating connection is gone; the broker guards every invocation so a
 * failing callback can never take a lane down.
 */
export interface SubmitCallbacks {
  readonly onStarted: (info: StartedInfo) => Effect.Effect<void>;
  readonly onOutput: (info: OutputInfo) => Effect.Effect<void>;
  readonly onExit: (info: ExitInfo) => Effect.Effect<void>;
}

export interface SubmitResult {
  readonly ticket: string;
  readonly laneKey: string;
  readonly position: number;
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

interface Job {
  readonly id: number;
  readonly ticket: string;
  readonly laneKey: string;
  readonly input: SubmitInput;
  readonly callbacks: SubmitCallbacks;
  readonly killSignal: Deferred.Deferred<void>;
  readonly state: Ref.Ref<JobState>;
  readonly queuedAtMs: number;
}

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

const finishExit = (
  ledger: LedgerApi,
  lane: Lane | null,
  inFlight: Map<string, Job>,
  job: Job,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    yield* Ref.set(job.state, 'finished');
    if (lane !== null) {
      yield* Ref.update(lane.running, (current) => (current === job.ticket ? null : current));
    }
    yield* Effect.sync(() => inFlight.delete(job.ticket));
  });

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
    const inFlight = new Map<string, Job>();

    const finishKilledBeforeRun = (lane: Lane, job: Job): Effect.Effect<void> =>
      Effect.gen(function* () {
        const atMs = Date.now();
        yield* ledger.markFinished(job.id, {
          status: 'killed',
          atMs,
          error: 'killed while queued',
        });
        yield* finishExit(ledger, lane, inFlight, job);
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
        const result = yield* executeCargo({
          argv: job.input.argv,
          cwd: job.input.cwd,
          env: job.input.env,
          killSignal: job.killSignal,
          tailBytes: config.outputTailBytes,
          onOutput: (channel, data) =>
            guarded(job.callbacks.onOutput({ ticket: job.ticket, channel, data })),
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
              .pipe(Effect.zipRight(finishExit(ledger, lane, inFlight, job)), Effect.ignore),
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
        yield* finishExit(ledger, lane, inFlight, job);
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
                yield* Effect.logError(
                  `lane ${lane.key} job ${job.ticket} crashed: ${Cause.pretty(cause)}`,
                );
                yield* ledger
                  .markFinished(job.id, {
                    status: 'failed',
                    atMs: Date.now(),
                    error: Cause.pretty(cause),
                  })
                  .pipe(Effect.ignore);
                yield* finishExit(ledger, lane, inFlight, job);
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
    // Only the ledger-insert + enqueue section is atomic, so a connection
    // dying mid-submit can never leave a ledger row without a queued job.
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
            const killSignal = yield* Deferred.make<void>();
            const state = yield* Ref.make<JobState>('queued');
            const job: Job = {
              id: created.id,
              ticket: created.ticket,
              laneKey,
              input,
              callbacks,
              killSignal,
              state,
              queuedAtMs: createdAtMs,
            };
            yield* Effect.sync(() => inFlight.set(job.ticket, job));
            yield* ledger.markQueued(created.id, createdAtMs);
            const position = yield* Queue.size(lane.queue);
            yield* Queue.offer(lane.queue, job);
            return { ticket: created.ticket, laneKey, position };
          }),
        );
      });

    const kill = (ticket: string, options?: KillOptions): Effect.Effect<boolean> =>
      Effect.gen(function* () {
        const job = inFlight.get(ticket);
        if (job === undefined) {
          return false;
        }
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
