import * as Effect from 'effect/Effect';
import * as Metric from 'effect/Metric';

import { batchFailureOwned, compositePackages } from './batch.js';
import { attachModeMetric, jobOutcomeMetric } from './broker-metrics.js';
import { hasLibKind, parseCargoJsonLine } from './cargo-json.js';
import { attachModeFor } from './coverage.js';
import {
  addDiagnostic,
  attachmentReceives,
  demandSatisfied,
  diagnosticFinishFields,
  diagnosticsForAttachment,
  guarded,
  makeDiagnosticAccumulator,
  requeueReasonFor,
  settlementStep,
} from './job-state.js';
import type { Attachment, ExitInfo, Job } from './job-state.js';
import type { LedgerApi } from './ledger.js';
import type { AttachMode, FinishedStatus } from './protocol.js';
import type { ReplayAudience, ReplayChunk } from './replay.js';
import { calculateServedSavings } from './savings.js';
import type { ServedSavings } from './savings.js';
import type { TicketDirectory } from './ticket-directory.js';

/**
 * Registration, gate checks, and detachment run in single synchronous frames
 * so they cannot interleave with settlement.
 */

export interface AttachmentRuntimeDeps {
  readonly ledger: LedgerApi;
  readonly directory: TicketDirectory;
}

export interface AttachmentRuntime {
  readonly emitChunk: (
    job: Job,
    channel: 'stdout' | 'stderr',
    data: Uint8Array,
    audience?: ReplayAudience,
  ) => Effect.Effect<void>;
  readonly notifyAttachmentStarted: (attachment: Attachment, atMs: number) => Effect.Effect<boolean>;
  readonly finishAttachment: (
    attachment: Attachment,
    atMs: number,
    exit: Omit<ExitInfo, 'ticket' | 'waitMs' | 'runMs'>,
  ) => Effect.Effect<void>;
  readonly finishAttachmentWithNote: (
    attachment: Attachment,
    atMs: number,
    note: string,
    exit: Omit<ExitInfo, 'ticket' | 'waitMs' | 'runMs'>,
  ) => Effect.Effect<void>;
  readonly tryRegisterAttachment: (
    laneKey: string,
    attachment: Attachment,
  ) => Effect.Effect<{ readonly leader: Job; readonly mode: AttachMode } | null>;
  readonly removeAttachment: (job: Job, attachment: Attachment) => Effect.Effect<boolean>;
  readonly releaseSatisfiedAttachments: (job: Job) => Effect.Effect<void>;
  readonly completeAttachRegistration: (
    leader: Job,
    attachment: Attachment,
    mode: AttachMode,
    atMs: number,
  ) => Effect.Effect<void>;
  readonly handleStdoutLine: (job: Job, line: string) => Effect.Effect<void>;
  readonly detachAll: (job: Job) => Effect.Effect<readonly Attachment[]>;
  readonly settleAttachments: (
    requeue: ((attachment: Attachment, reason: string) => Effect.Effect<void>) | null,
    job: Job,
    status: FinishedStatus,
    exitCode: number | null,
    signal: string | null,
    error: string | null,
    atMs: number,
  ) => Effect.Effect<void>;
}

const nonNegativeMs = (value: number): number => Math.max(0, Math.round(value));

/**
 * A raw-output leader spawned with a merged pipe delivers cargo's stderr on
 * its stdout channel. A follower whose caller keeps separate descriptors
 * would print that stderr to its stdout (and vice versa), so the two only
 * share a run when they agree on `mergeStderr`. Demux runs own stdout and
 * never merge, so the flag is irrelevant there.
 */
const channelsCompatible = (leader: Job, attachment: Attachment): boolean =>
  leader.demux !== null ||
  (leader.input.mergeStderr === true) === (attachment.input.mergeStderr === true);

const leaderRunMsAt = (job: Job, atMs: number): number | null =>
  job.startedAtMs === null ? null : nonNegativeMs(atMs - job.startedAtMs);

const servedSavings = (
  attachment: Attachment,
  atMs: number,
  leaderRunMs: number | null,
): ReturnType<typeof calculateServedSavings> =>
  calculateServedSavings(
    attachment.mode,
    attachment.estimateMs,
    attachment.createdAtMs,
    atMs,
    leaderRunMs,
  );

export const makeAttachmentRuntime = (deps: AttachmentRuntimeDeps): AttachmentRuntime => {
  const { ledger, directory } = deps;

  /**
   * Fans one output chunk to the leader, the replay buffer, the leader-view
   * tail, the on-disk ticket log, and every attachment the filter admits.
   * Coverage attachments see only chunks relevant to their scope in demux
   * mode; identity attachments always see everything.
   *
   * The log gets exactly what flows through here, in arrival order, bytes
   * as captured (ANSI included). For a demultiplexed run that is the
   * rendered view — cargo's JSON message stream never reaches this point;
   * `handleStdoutLine` forwards each diagnostic's `rendered` text and the
   * non-JSON stdout lines instead — which is what a reader triaging the
   * ticket wants, not the raw `--message-format=json` lines.
   */
  const emitChunk = (
    job: Job,
    channel: 'stdout' | 'stderr',
    data: Uint8Array,
    audience: ReplayAudience = { kind: 'all' },
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      const encodedData = Buffer.from(data).toString('base64');
      const liveAttachments = yield* Effect.sync(() => {
        job.lastOutputAtMs = Date.now();
        job.replay.push(channel, data, audience, encodedData);
        job.tail.push(data);
        job.log?.write(data);
        const live: Attachment[] = [];
        for (const attachment of job.attachments.values()) {
          if (!attachmentReceives(attachment, audience)) {
            continue;
          }
          if (attachment.live) {
            live.push(attachment);
          } else {
            attachment.pendingLive.push({
              channel,
              data: Buffer.from(data),
              encodedData,
              audience,
            });
          }
        }
        return live;
      });
      yield* guarded(
        job.callbacks.onOutput({ ticket: job.ticket, channel, data: encodedData }),
      );
      yield* Effect.forEach(
        liveAttachments,
        (attachment) =>
          Effect.sync(() => attachment.tail.push(data)).pipe(
            Effect.andThen(
              guarded(
                attachment.callbacks.onOutput({
                  ticket: attachment.ticket,
                  channel,
                  data: encodedData,
                }),
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
                data: chunk.encodedData,
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
   *
   * The snapshot and the reset of `pendingLive` share one sync frame: every
   * chunk emitted since registration is already in the replay buffer, so
   * anything queued on the attachment so far would otherwise be delivered
   * twice (once from the snapshot, once from the drain).
   */
  const replayThenGoLive = (job: Job, attachment: Attachment): Effect.Effect<void> =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.sync(() => {
        const taken = job.replay.snapshot();
        attachment.pendingLive.length = 0;
        return taken;
      });
      if (snapshot.droppedBytes > 0) {
        const notice = Buffer.from(
          `[cargo-hauler] replay truncated: ${snapshot.droppedBytes} earlier output bytes dropped\n`,
        );
        const encodedNotice = notice.toString('base64');
        yield* Effect.sync(() => attachment.tail.push(notice));
        yield* guarded(
          attachment.callbacks.onOutput({
            ticket: attachment.ticket,
            channel: 'stderr',
            data: encodedNotice,
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
    savings: ServedSavings | null = null,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      const startedAtMs = attachment.startedAtMs;
      // The attachment is already detached, so this is its only exit path:
      // a ledger or metric defect must not withhold the caller's exit.
      yield* settlementStep(
        `ledger.markFinished (${attachment.ticket})`,
        ledger.markFinished(attachment.id, {
          status: exit.status,
          atMs,
          exitCode: exit.exitCode,
          signal: exit.signal,
          outputTail: attachment.tail.toString(),
          error: exit.error,
          ...(savings === null ? {} : savings),
          ...diagnosticFinishFields(attachment.diagnostics),
        }),
      );
      yield* settlementStep(
        `metrics (${attachment.ticket})`,
        Metric.update(jobOutcomeMetric, exit.status),
      );
      yield* settlementStep(
        `notifyWaiters (${attachment.ticket})`,
        directory.notifyWaiters(attachment.ticket),
      );
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

  /** Deliver the at-most-once start notice plus one hauler stderr note, then finish. */
  const finishAttachmentWithNote = (
    attachment: Attachment,
    atMs: number,
    note: string,
    exit: Omit<ExitInfo, 'ticket' | 'waitMs' | 'runMs'>,
    savings: ServedSavings | null = null,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      yield* notifyAttachmentStarted(attachment, atMs);
      const noteData = Buffer.from(note);
      const encodedNote = noteData.toString('base64');
      yield* Effect.sync(() => attachment.tail.push(noteData));
      yield* guarded(
        attachment.callbacks.onOutput({
          ticket: attachment.ticket,
          channel: 'stderr',
          data: encodedNote,
        }),
      );
      yield* finishAttachment(attachment, atMs, exit, savings);
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
        directory.setAttachment(job, attachment);
        return { leader: job, mode };
      };
      let coverageCandidate: Job | null = null;
      for (const entry of directory.entries()) {
        if (entry.kind !== 'leader') {
          continue;
        }
        const job = entry.job;
        if (
          job.laneKey !== laneKey ||
          !job.attachGate.open ||
          !channelsCompatible(job, attachment)
        ) {
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

  const removeAttachment = (job: Job, attachment: Attachment): Effect.Effect<boolean> =>
    Effect.sync(() => {
      const present = job.attachments.delete(attachment.ticket);
      if (present) {
        directory.remove(attachment.ticket);
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
          directory.remove(release.attachment.ticket);
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
      // Released from the stdout pump: a ledger or metric defect here must
      // not surface as a pump failure that terminates the leader's cargo.
      yield* Effect.forEach(
        decided,
        ({ attachment, failed }) =>
          settlementStep(
            `early release (${attachment.ticket})`,
            finishAttachmentWithNote(
              attachment,
              atMs,
              failed === null
                ? `[cargo-hauler] released early: requested packages compiled cleanly under ${job.ticket}\n`
                : `[cargo-hauler] released early: ${failed} failed to compile under ${job.ticket}\n`,
              failed === null
                ? { status: 'done', exitCode: 0, signal: null, error: null }
                : {
                    status: 'failed',
                    exitCode: 101,
                    signal: null,
                    error: `compile errors in ${failed}`,
                  },
              servedSavings(attachment, atMs, null),
            ),
          ),
        { discard: true },
      );
    });

  /**
   * Follow-up after tryRegisterAttachment wins: ledger the attach, and if
   * the leader is already running, deliver the start notice and replay
   * catch-up, then re-check early release — the demand may already be
   * proven by units that finished before this attachment arrived.
   *
   * The registration frame and this follow-up are separate steps, so the
   * leader may have settled (or the attachment been killed or released) in
   * between; then the attachment already carries its terminal row and exit,
   * and the attach/running writes below would resurrect it as non-terminal.
   */
  const completeAttachRegistration = (
    leader: Job,
    attachment: Attachment,
    mode: AttachMode,
    atMs: number,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      const stillAttached = yield* Effect.sync(() =>
        leader.attachments.get(attachment.ticket) === attachment,
      );
      if (!stillAttached) {
        yield* Effect.logDebug('attachment settled before registration completed', {
          leader: leader.ticket,
          ticket: attachment.ticket,
        });
        return;
      }
      yield* Effect.logDebug('registered attachment', {
        leader: leader.ticket,
        mode,
      });
      yield* ledger.markAttached(attachment.id, { atMs, leaderTicket: leader.ticket, mode });
      yield* Metric.update(attachModeMetric, mode);
      if (leader.startedAtMs === null) {
        return;
      }
      // A follower shares the leader's run, so it shares the leader's log.
      yield* ledger.markRunning(
        attachment.id,
        leader.startedAtMs,
        undefined,
        leader.log?.path ?? null,
      );
      const won = yield* notifyAttachmentStarted(attachment, leader.startedAtMs);
      if (won) {
        yield* replayThenGoLive(leader, attachment);
      }
      yield* releaseSatisfiedAttachments(leader);
    });

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
        directory.remove(attachment.ticket);
      }
      return detached;
    });

  /**
   * Mirrors or requeues every attachment after the leader reached `status`.
   * `requeue` is the lane machine's re-entry point; null (daemon shutdown)
   * finishes detached attachments as killed instead.
   */
  const settleAttachments = (
    requeue: ((attachment: Attachment, reason: string) => Effect.Effect<void>) | null,
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
      const leaderRunMs = leaderRunMsAt(job, atMs);
      // Every package the composite ran, for attributing a folded test
      // failure: the leader's own plus each folded participant's.
      const composite = compositePackages(
        job.intent,
        detached
          .filter((attachment) => attachment.mode === 'batch')
          .map((attachment) => attachment.intent),
      );
      const settleOne = (attachment: Attachment): Effect.Effect<void> => {
        // A failed leader can still prove a coverage demand: the demanded
        // units may have compiled cleanly before an unrelated unit failed.
        const provenDespiteFailure =
          status === 'failed' &&
          attachment.mode !== 'identity' &&
          job.demux !== null &&
          demandSatisfied(attachment.intent, job.demux);
        // A folded test participant inherits the composite's failure only
        // when it named every package the composite ran; otherwise the
        // failing tests may belong to another participant's package, and
        // it requeues to run alone (#53). Compile batches always requeue.
        const mirrors =
          status === 'done' ||
          (status === 'failed' &&
            (attachment.mode === 'identity' ||
              (attachment.mode === 'batch' &&
                batchFailureOwned(job.intent, composite, attachment.intent))));
        if (provenDespiteFailure) {
          return finishAttachmentWithNote(
            attachment,
            atMs,
            `[cargo-hauler] ${job.ticket} failed elsewhere, but your requested packages compiled cleanly\n`,
            { status: 'done', exitCode: 0, signal: null, error: null },
            servedSavings(attachment, atMs, leaderRunMs),
          );
        }
        if (mirrors) {
          return notifyAttachmentStarted(attachment, atMs).pipe(
            Effect.andThen(
              finishAttachment(
                attachment,
                atMs,
                { status, exitCode, signal, error },
                servedSavings(attachment, atMs, leaderRunMs),
              ),
            ),
          );
        }
        if (requeue !== null) {
          return requeue(attachment, requeueReasonFor(attachment.mode, status));
        }
        return finishAttachment(attachment, atMs, {
          status: 'killed',
          exitCode: null,
          signal: null,
          error: 'daemon shutdown',
        });
      };
      // One follower's defect must not strand the followers after it.
      for (const attachment of detached) {
        yield* settlementStep(`follower settlement (${attachment.ticket})`, settleOne(attachment));
      }
    });

  return {
    emitChunk,
    notifyAttachmentStarted,
    finishAttachment,
    finishAttachmentWithNote,
    tryRegisterAttachment,
    removeAttachment,
    releaseSatisfiedAttachments,
    completeAttachRegistration,
    handleStdoutLine,
    detachAll,
    settleAttachments,
  };
};
