import { availableParallelism, loadavg } from 'node:os';

import * as Cause from 'effect/Cause';
import * as Context from 'effect/Context';
import * as Data from 'effect/Data';
import * as Deferred from 'effect/Deferred';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Metric from 'effect/Metric';
import * as Ref from 'effect/Ref';
import * as ChildProcessSpawner from 'effect/unstable/process/ChildProcessSpawner';

import {
  attachModeMetric,
  cargoRunByKindMetric,
  cargoRunKinds,
  cargoRunMetric,
  jobOutcomeMetric,
  waitMsSummary,
} from './broker-metrics.js';
import { DaemonConfig } from './config.js';
import { CostModel } from './cost.js';
import { createSystemIoSampler } from './disk-stats.js';
import { TailBuffer } from './executor.js';
import { normalizeCargoIntent } from './intent-normalizer.js';
import { isTerminalStatus, makeAttachment, remainingEstimateMs } from './job-state.js';
import type {
  Attachment,
  Job,
  JobState,
  SubmitCallbacks,
  SubmitInput,
} from './job-state.js';
import { laneKeyFor, makeLaneRuntime } from './lane-exec.js';
import { Ledger } from './ledger.js';
import { memoryAvailableBytes, memoryPressureLevel, memoryPsi } from './pressure.js';
import { parseTicket } from './protocol.js';
import type {
  AttachMode,
  EstimateSource,
  HistogramMetricSnapshot,
  LaneStatus,
  RequestRecord,
  SessionCompletedRecord,
  SessionPendingRecord,
  StatusReport,
} from './protocol.js';
import { memoryClampState } from './scheduler.js';
import { StallProbe, makeStallMonitor } from './stall.js';
import { makeTicketDirectory } from './ticket-directory.js';
import { Topology } from './topology.js';
import { findConfiguredTargetDir, locateWorkspaceRoot } from './workspace.js';

export type {
  ExitInfo,
  OutputInfo,
  RequeuedInfo,
  StartedInfo,
  SubmitCallbacks,
  SubmitInput,
} from './job-state.js';

export interface AttemptInput {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly session?: string | undefined;
  readonly host?: string | undefined;
  readonly reason: string;
}

export interface SubmitResult {
  readonly ticket: string;
  readonly laneKey: string;
  readonly position: number;
  readonly attachedTo?: string;
  readonly attachMode?: AttachMode;
  /** Estimated remaining runtime for queued requests or their attached leader. */
  readonly etaMs?: number;
  readonly etaSource?: EstimateSource;
  /** Estimated wait before a queued leader starts (lane work ahead of it). */
  readonly waitEtaMs?: number;
}

export interface KillOptions {
  readonly onlyIfQueued?: boolean;
  /** Ledger `error` for a running leader killed by the daemon itself (stall auto-kill). */
  readonly reason?: string;
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
  /**
   * Record that the connection owning a running leader is gone (#46): the
   * run continues, but a later stall verdict may kill it automatically.
   * False for riders, queued work, and unknown tickets.
   */
  readonly markOwnerGone: (ticket: string) => Effect.Effect<boolean>;
  /** Record that the submitting client stopped streaming the ticket; false when the ticket is unknown. */
  readonly detach: (ticket: string) => Effect.Effect<boolean>;
  readonly report: (recentLimit?: number) => Effect.Effect<StatusReport>;
  readonly getTicket: (ticket: string) => Effect.Effect<RequestRecord | null>;
  readonly awaitTicket: (ticket: string, maxWaitMs: number) => Effect.Effect<AwaitTicketResult>;
  /** Test-only visibility for interruption cleanup assertions. */
  readonly _testWaiterCount: (ticket?: string) => Effect.Effect<number>;
  readonly sessionPending: (session: string) => Effect.Effect<readonly SessionPendingRecord[]>;
  readonly sessionCompleted: (
    session: string,
    sinceMs: number,
  ) => Effect.Effect<readonly SessionCompletedRecord[]>;
}

export class Broker extends Context.Service<Broker, BrokerApi>()('cargo-hauler/Broker') {}

const invalidLaneKey = 'invalid';

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

    const directory = makeTicketDirectory((ticket) => ledger.getRequestByTicket(ticket));
    // Disk/IO pressure needs a previous /proc sample to be honest, so the
    // sampler lives for the daemon's lifetime and each status report advances
    // it. Non-Linux platforms simply never produce a sample.
    const systemIo = createSystemIoSampler();
    const lanesRuntime = yield* makeLaneRuntime({
      config,
      costModel,
      daemonScope,
      directory,
      ledger,
      spawner,
      topology,
    });
    const attachments = lanesRuntime.attachments;

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
        const lane = yield* lanesRuntime.getOrCreateLane(
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
              estimateSource: estimate.source,
              tail: new TailBuffer(config.outputTailBytes),
              attachedAtMs: createdAtMs,
            });
            const registered = yield* attachments.tryRegisterAttachment(laneKey, attachment);
            if (registered !== null) {
              yield* registerOwnership(callbacks, created.ticket);
              yield* attachments.completeAttachRegistration(
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
                etaSource: registered.leader.estimateSource,
              };
            }
            const job = yield* lanesRuntime.makeJob(
              created.id,
              created.ticket,
              laneKey,
              input,
              normalized,
              callbacks,
              createdAtMs,
              estimate,
            );
            yield* Effect.sync(() => directory.setLeader(job));
            yield* ledger.markQueued(created.id, createdAtMs);
            const ownershipAccepted = yield* registerOwnership(callbacks, created.ticket);
            if (!ownershipAccepted) {
              yield* Ref.set(job.state, 'kill-requested');
              yield* Deferred.succeed(job.killSignal, undefined);
            }
            const position = yield* lanesRuntime.enqueueJob(lane, job);
            // The client's auto-background decision needs the whole wall
            // time, not just this job's runtime (#55).
            const queued = yield* lanesRuntime.requestStatusFields(created.ticket, Date.now());
            return {
              ticket: created.ticket,
              laneKey,
              position,
              etaMs: job.estimateMs,
              etaSource: job.estimateSource,
              ...(queued.queue === undefined ? {} : { waitEtaMs: queued.queue.waitEtaMs }),
            };
          }),
        );
      });

    /**
     * The ledger only stores an output tail at settlement, but the in-flight
     * job (or a follower's attachment view) accumulates one live. Overlay it
     * so a running ticket's record shows progress instead of nothing — a
     * long cargo run polled via `hauler result` or the dashboard drawer
     * should never be blind until the end.
     */
    const withLiveTail = (record: RequestRecord): RequestRecord => {
      if (isTerminalStatus(record.status)) {
        return record;
      }
      const entry = directory.get(record.ticket);
      if (entry === undefined) {
        return record;
      }
      const tail = entry.kind === 'leader' ? entry.job.tail : entry.attachment.tail;
      const text = tail.toString();
      return text.length === 0 ? record : { ...record, outputTail: text, outputTailLive: true };
    };

    const withLiveStatus = (
      record: RequestRecord | null,
      atMs = Date.now(),
    ): Effect.Effect<RequestRecord | null> => {
      if (record === null || isTerminalStatus(record.status)) {
        return Effect.succeed(record);
      }
      const liveRecord = withLiveTail(record);
      return lanesRuntime.requestStatusFields(record.ticket, atMs).pipe(
        Effect.map((fields) => ({ ...liveRecord, ...fields })),
      );
    };

    const getTicket = (ticket: string): Effect.Effect<RequestRecord | null> =>
      ledger.getRequestByTicket(ticket).pipe(Effect.flatMap((record) => withLiveStatus(record)));

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
          yield* Effect.sync(() => directory.registerWaiter(ticket, waiter));
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
                  Effect.flatMap((record) =>
                    withLiveStatus(record).pipe(
                      Effect.map((liveRecord) => ({
                        record: liveRecord,
                        timedOut: liveRecord === null || !isTerminalStatus(liveRecord.status),
                      })),
                    ),
                  ),
                ),
              ),
            );
          }),
        (waiter) => Effect.sync(() => directory.removeWaiter(ticket, waiter)),
      );

    const _testWaiterCount = (ticket?: string): Effect.Effect<number> =>
      Effect.sync(() => directory.waiterCount(ticket));

    const sessionPending = (session: string): Effect.Effect<readonly SessionPendingRecord[]> =>
      ledger.sessionPending(session);

    const sessionCompleted = (
      session: string,
      sinceMs: number,
    ): Effect.Effect<readonly SessionCompletedRecord[]> =>
      ledger.sessionCompleted(session, sinceMs);

    const detach = (ticket: string): Effect.Effect<boolean> => {
      const id = parseTicket(ticket);
      return id === null ? Effect.succeed(false) : ledger.markDetached(id);
    };

    const killAttachment = (entry: {
      readonly leader: Job;
      readonly attachment: Attachment;
    }): Effect.Effect<boolean> =>
      Effect.gen(function* () {
        const removed = yield* attachments.removeAttachment(entry.leader, entry.attachment);
        if (!removed) {
          return false;
        }
        yield* attachments.finishAttachment(
          entry.attachment,
          Date.now(),
          { status: 'killed', exitCode: null, signal: null, error: 'detached by kill' },
        );
        return true;
      });

    const kill = (ticket: string, options?: KillOptions): Effect.Effect<boolean> =>
      Effect.gen(function* () {
        const entry = directory.get(ticket);
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
        const claim = yield* Ref.modify(
          job.state,
          (state): readonly [{ readonly signal: boolean; readonly inFlight: boolean }, JobState] => {
            switch (state) {
              case 'queued':
                return [{ signal: true, inFlight: false }, 'kill-requested'];
              case 'starting':
              case 'running':
                return [{ signal: true, inFlight: true }, state];
              case 'kill-requested':
                return [{ signal: true, inFlight: false }, state];
              case 'finished':
                return [{ signal: false, inFlight: false }, state];
              default: {
                const exhaustive: never = state;
                return exhaustive;
              }
            }
          },
        );
        if (claim.inFlight && options?.reason !== undefined && job.killReason === null) {
          yield* Effect.sync(() => {
            job.killReason = options.reason ?? null;
          });
        }
        if (claim.signal) {
          yield* Deferred.succeed(job.killSignal, undefined);
        }
        return claim.signal;
      });

    const markOwnerGone = (ticket: string): Effect.Effect<boolean> =>
      Effect.sync(() => {
        const entry = directory.get(ticket);
        if (entry === undefined || entry.kind !== 'leader') {
          return false;
        }
        const state = Ref.getUnsafe(entry.job.state);
        if (state !== 'starting' && state !== 'running') {
          return false;
        }
        entry.job.ownerGone = true;
        return true;
      });

    const stallProbe = yield* StallProbe;
    yield* Effect.forkIn(
      makeStallMonitor({
        config,
        directory,
        probe: stallProbe,
        kill: (ticket, reason) => kill(ticket, { reason }),
      }),
      daemonScope,
    );

    const report = (recentLimit = 50): Effect.Effect<StatusReport> =>
      Effect.gen(function* () {
        const histogramSnapshot = (snapshot: {
          readonly buckets: ReadonlyArray<readonly [number, number]>;
          readonly count: number;
          readonly min: number;
          readonly max: number;
          readonly sum: number;
        }): HistogramMetricSnapshot => ({
          buckets: snapshot.buckets.map(([boundary, count]) => [
            Number.isFinite(boundary) ? boundary : null,
            count,
          ] as const),
          count: snapshot.count,
          min: snapshot.count === 0 ? null : snapshot.min,
          max: snapshot.count === 0 ? null : snapshot.max,
          sum: snapshot.sum,
        });
        yield* ledger.ingestPassthroughSpool(config.stateDir);
        const laneStatuses: readonly LaneStatus[] = yield* lanesRuntime.laneStatuses();
        const reportAtMs = Date.now();
        const activeRecords = yield* ledger.activeStatusRequests();
        const active = yield* Effect.forEach(
          activeRecords,
          (record) => withLiveStatus(record, reportAtMs).pipe(Effect.map((live) => live ?? record)),
        );
        const recent = yield* ledger.recentStatusRequests(recentLimit);
        const cargoRun = yield* Metric.value(cargoRunMetric);
        const cargoRunByKind = yield* Effect.forEach(
          cargoRunKinds,
          (kind) =>
            Metric.value(cargoRunByKindMetric(kind)).pipe(
              Effect.map((snapshot) => [kind, histogramSnapshot(snapshot)] as const),
            ),
        );
        const jobOutcome = yield* Metric.value(jobOutcomeMetric);
        const attachMode = yield* Metric.value(attachModeMetric);
        const waitSummary = yield* Metric.value(waitMsSummary);
        const nowMs = Date.now();
        const metricWindows = yield* ledger.metricsWindows(nowMs);
        const kache = yield* costModel.kacheStatus;
        const savings = yield* ledger.attachmentSavings();
        // Devices worth watching right now: the hauler's own state disk
        // plus whatever disks the in-flight builds are writing to.
        const ioSample = yield* Effect.sync(() =>
          systemIo.sample([
            config.stateDir,
            ...laneStatuses
              .filter((lane) => lane.runningTicket !== null)
              .map((lane) => lane.targetDir),
          ]),
        );
        const memorySample = yield* Effect.sync(() => {
          const psi = memoryPsi();
          const availableBytes = memoryAvailableBytes();
          const pressureLevel = memoryPressureLevel();
          const clamp = memoryClampState({
            loadPerCore: 0,
            memAvailableBytes: availableBytes,
            memAvailableMinBytes: config.memAvailableMinBytes,
            memFullAvg10: psi?.fullAvg10 ?? null,
            memFullAvg60: psi?.fullAvg60 ?? null,
            memHardThreshold: config.memPressureHardThreshold,
            memPressureLevel: pressureLevel,
            memPressureLevelThreshold: config.memPressureLevelThreshold,
            memSoftThreshold: config.memPressureSoftThreshold,
            minConcurrent: config.loadMinConcurrent,
            running: 0,
            thresholdPerCore: Number.POSITIVE_INFINITY,
          });
          return { availableBytes, clamp, pressureLevel, psi };
        });
        const heavy = yield* lanesRuntime.heavyAdmission(memorySample.availableBytes);
        return {
          pid: process.pid,
          startedAtMs,
          socketPath: config.socketPath,
          maxConcurrent: config.maxConcurrent,
          lanes: laneStatuses,
          active,
          recent,
          kache,
          system: {
            loadAvg1: loadavg()[0],
            cores: availableParallelism(),
            clampThresholdPerCore: config.loadThresholdPerCore,
            ...(ioSample?.ioWaitPercent == null
              ? {}
              : { ioWaitPercent: ioSample.ioWaitPercent }),
            ...(ioSample !== null && ioSample.disks.length > 0
              ? { disks: ioSample.disks }
              : {}),
            ...(memorySample.psi === null
              ? {}
              : {
                  memFullAvg10: memorySample.psi.fullAvg10,
                  memSomeAvg10: memorySample.psi.someAvg10,
                }),
            ...(memorySample.availableBytes === null
              ? {}
              : { memAvailableBytes: memorySample.availableBytes }),
            ...(memorySample.pressureLevel === null
              ? {}
              : { memPressureLevel: memorySample.pressureLevel }),
            memClamp: memorySample.clamp,
            ...(heavy === null ? {} : { heavy }),
          },
          metrics: {
            cargo_run_ms: histogramSnapshot(cargoRun),
            cargo_run_ms_by_kind: Object.fromEntries(cargoRunByKind),
            job_outcome: Object.fromEntries(jobOutcome.occurrences),
            attach_mode: Object.fromEntries(attachMode.occurrences),
            wait_ms_summary: {
              count: waitSummary.count,
              min: waitSummary.count === 0 ? null : waitSummary.min,
              max: waitSummary.count === 0 ? null : waitSummary.max,
              sum: waitSummary.sum,
              quantiles: waitSummary.quantiles.map(([quantile, value]) => [
                quantile,
                value ?? null,
              ] as const),
            },
            windows: [
              { id: 'hour', ...metricWindows.hour },
              { id: 'day', ...metricWindows.day },
              { id: 'all', ...metricWindows.all },
            ],
          },
          savings,
        };
      });

    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        yield* lanesRuntime.interruptWorkers();
        const remaining = yield* Effect.sync(() => {
          const jobs = new Set<Job>();
          for (const entry of directory.entries()) {
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
        yield* Effect.forEach(remaining, lanesRuntime.settleInterruptedJob, {
          concurrency: 1,
          discard: true,
        });
      }),
    );

    return {
      submit,
      recordAttempt,
      kill,
      markOwnerGone,
      detach,
      report,
      getTicket,
      awaitTicket,
      _testWaiterCount,
      sessionPending,
      sessionCompleted,
    } satisfies BrokerApi;
  }),
);
