import * as Data from 'effect/Data';
import * as Deferred from 'effect/Deferred';
import * as Effect from 'effect/Effect';
import * as Queue from 'effect/Queue';
import * as Ref from 'effect/Ref';
import type { Scope } from 'effect/Scope';

import { isTerminalStatus } from './job-state.js';
import type { Job } from './job-state.js';
import type { Lane } from './lane-exec.js';
import type { LedgerApi } from './ledger.js';
import { parseTicket } from './protocol.js';
import type { PrerequisiteContext, RequestRecord } from './protocol.js';
import type { TicketDirectory } from './ticket-directory.js';

/**
 * Explicit ticket dependencies (`hauler exec --after cc-N`, issue #45).
 *
 * Lane admission is cost-ordered, so a cheap queued test can otherwise run
 * before the expensive queued build whose artefact it needs. A dependent is
 * enqueued like any job but stays unschedulable — skipped by admission and
 * batch folding — until every prerequisite has settled. A prerequisite that
 * ends other than `done` fails the dependent with `prerequisite cc-N <status>`
 * without ever spawning cargo. Prerequisites may live in any lane; the
 * watcher rides the same per-ticket waiter list `hauler await` uses, so
 * every settlement path (leaders, riders, early releases) releases it.
 */

export class UnknownPrerequisiteError extends Data.TaggedError('UnknownPrerequisite')<{
  readonly ticket: string;
  readonly message: string;
}> {}

class PrerequisiteFailed extends Data.TaggedError('PrerequisiteFailed')<{
  readonly ticket: string;
  readonly status: string;
}> {}

export interface ResolvedPrerequisites {
  /** Deduplicated prerequisites in submission order; what the ledger row stores. */
  readonly after: readonly string[];
  /** The prerequisites not yet `done`; the dependent is blocked while any remain. */
  readonly pending: readonly string[];
}

export interface DependencyRuntimeDeps {
  readonly directory: TicketDirectory;
  readonly ledger: Pick<LedgerApi, 'getRequestByTicket'>;
  readonly daemonScope: Scope;
  /** Settles a queued job as `failed` with `error` and drops it from its lane (lane-exec). */
  readonly failPendingJob: (lane: Lane, job: Job, error: string) => Effect.Effect<void>;
}

export interface DependencyRuntime {
  /** Validates `after` against the ledger; an unknown or malformed ticket rejects the submission. */
  readonly resolve: (
    after: readonly string[] | undefined,
  ) => Effect.Effect<ResolvedPrerequisites, UnknownPrerequisiteError>;
  /** Marks `job` blocked on `pending`, in the caller's synchronous frame, before it is enqueued. */
  readonly block: (job: Job, pending: readonly string[]) => Effect.Effect<void>;
  /** Forks the watcher that releases (or fails) an enqueued blocked job as its prerequisites settle. */
  readonly watch: (lane: Lane, job: Job) => Effect.Effect<void>;
  /** Live view of the prerequisites `job` still waits on, for status and heartbeats. */
  readonly waitingFor: (job: Job, atMs: number) => Effect.Effect<readonly PrerequisiteContext[]>;
}

/** A job is schedulable once nothing blocks it, or once a kill has claimed it (so the lane can settle it). */
export const isSchedulable = (job: Job): boolean =>
  job.waitingFor.size === 0 || Ref.getUnsafe(job.state) !== 'queued';

/** The `error` a dependent settles with when a prerequisite ended other than `done`. */
export const prerequisiteFailureError = (ticket: string, status: string): string =>
  `prerequisite ${ticket} ${status}`;

const prerequisiteSatisfied = (record: RequestRecord): boolean => record.status === 'done';

const dedupe = (tickets: readonly string[]): readonly string[] => [...new Set(tickets)];

export const makeDependencyRuntime = (deps: DependencyRuntimeDeps): DependencyRuntime => {
  const { directory, ledger, daemonScope, failPendingJob } = deps;

  const resolve: DependencyRuntime['resolve'] = (after) =>
    Effect.gen(function* () {
      const tickets = dedupe(after ?? []);
      const pending: string[] = [];
      for (const ticket of tickets) {
        const record =
          parseTicket(ticket) === null ? null : yield* ledger.getRequestByTicket(ticket);
        if (record === null) {
          return yield* new UnknownPrerequisiteError({
            ticket,
            message: `unknown prerequisite ticket ${ticket} (--after needs a ticket the daemon has ledgered, like cc-123)`,
          });
        }
        if (!prerequisiteSatisfied(record)) {
          pending.push(ticket);
        }
      }
      return { after: tickets, pending };
    });

  const block: DependencyRuntime['block'] = (job, pending) =>
    Effect.sync(() => {
      for (const ticket of pending) {
        job.waitingFor.add(ticket);
      }
    });

  /**
   * Resolves with the prerequisite's terminal record. The waiter is
   * registered before the ledger read, mirroring `awaitTicket`: settlement
   * writes the row and then notifies waiters, so a prerequisite finishing
   * between the two steps is still observed.
   */
  const awaitSettled = (ticket: string): Effect.Effect<RequestRecord | null> =>
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
            return null;
          }
          if (isTerminalStatus(current.status)) {
            return current;
          }
          return yield* Deferred.await(waiter);
        }),
      (waiter) => Effect.sync(() => directory.removeWaiter(ticket, waiter)),
    );

  const awaitPrerequisite = (job: Job, ticket: string): Effect.Effect<void, PrerequisiteFailed> =>
    Effect.gen(function* () {
      const record = yield* awaitSettled(ticket);
      yield* Effect.sync(() => {
        job.waitingFor.delete(ticket);
      });
      if (record === null || !prerequisiteSatisfied(record)) {
        return yield* new PrerequisiteFailed({ ticket, status: record?.status ?? 'unknown' });
      }
    });

  type WatchOutcome =
    | { readonly kind: 'released' }
    | { readonly kind: 'killed' }
    | { readonly kind: 'failed'; readonly failure: PrerequisiteFailed };

  const watchJob = (lane: Lane, job: Job): Effect.Effect<void> =>
    Effect.gen(function* () {
      const tickets = yield* Effect.sync(() => [...job.waitingFor]);
      // The first failed prerequisite decides; the remaining waits are
      // interrupted and their waiters removed.
      const released = Effect.forEach(tickets, (ticket) => awaitPrerequisite(job, ticket), {
        concurrency: 'unbounded',
        discard: true,
      }).pipe(
        Effect.map((): WatchOutcome => ({ kind: 'released' })),
        Effect.catchTag(
          'PrerequisiteFailed',
          (failure): Effect.Effect<WatchOutcome> => Effect.succeed({ kind: 'failed', failure }),
        ),
      );
      // A kill (client disconnect, `hauler kill`) must not wait for the
      // prerequisite: the lane settles the claimed job as soon as it wakes.
      const killed = Deferred.await(job.killSignal).pipe(
        Effect.map((): WatchOutcome => ({ kind: 'killed' })),
      );
      const outcome = yield* Effect.raceFirst(released, killed);
      switch (outcome.kind) {
        case 'released':
          yield* Effect.logDebug('prerequisites settled; releasing dependent', {
            ticket: job.ticket,
          });
          yield* Queue.offer(lane.wake, undefined);
          return;
        case 'killed':
          yield* Queue.offer(lane.wake, undefined);
          return;
        case 'failed':
          yield* Effect.logDebug('prerequisite failed; failing dependent', {
            prerequisite: outcome.failure.ticket,
            status: outcome.failure.status,
            ticket: job.ticket,
          });
          yield* failPendingJob(
            lane,
            job,
            prerequisiteFailureError(outcome.failure.ticket, outcome.failure.status),
          );
          return;
        default: {
          const exhaustive: never = outcome;
          return exhaustive;
        }
      }
    });

  const watch: DependencyRuntime['watch'] = (lane, job) =>
    Effect.asVoid(Effect.forkIn(watchJob(lane, job), daemonScope));

  const waitingFor: DependencyRuntime['waitingFor'] = (job, atMs) =>
    Effect.forEach([...job.waitingFor], (ticket) =>
      ledger.getRequestByTicket(ticket).pipe(
        Effect.map((record): readonly PrerequisiteContext[] =>
          record === null
            ? []
            : [
                {
                  ticket,
                  status: record.status,
                  ...(record.startedAtMs === null
                    ? {}
                    : { elapsedMs: Math.max(0, atMs - record.startedAtMs) }),
                  ...(record.estimateMs === null ? {} : { estimateMs: record.estimateMs }),
                },
              ],
        ),
      ),
    ).pipe(Effect.map((contexts) => contexts.flat()));

  return { resolve, block, watch, waitingFor };
};
