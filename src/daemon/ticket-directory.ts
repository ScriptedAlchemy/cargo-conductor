import * as Deferred from 'effect/Deferred';
import * as Effect from 'effect/Effect';

import type { Attachment, InFlightEntry, Job } from './job-state.js';
import type { RequestRecord } from './protocol.js';

export interface TicketDirectory {
  readonly get: (ticket: string) => InFlightEntry | undefined;
  readonly setLeader: (job: Job) => void;
  readonly setAttachment: (leader: Job, attachment: Attachment) => void;
  readonly remove: (ticket: string) => boolean;
  readonly entries: () => IterableIterator<InFlightEntry>;
  readonly registerWaiter: (ticket: string, waiter: Deferred.Deferred<RequestRecord>) => void;
  readonly removeWaiter: (ticket: string, waiter: Deferred.Deferred<RequestRecord>) => void;
  readonly waiterCount: (ticket?: string) => number;
  readonly notifyWaiters: (ticket: string) => Effect.Effect<void>;
}

export const makeTicketDirectory = (
  getRequestByTicket: (ticket: string) => Effect.Effect<RequestRecord | null>,
): TicketDirectory => {
  const inFlight = new Map<string, InFlightEntry>();
  const ticketWaiters = new Map<string, Deferred.Deferred<RequestRecord>[]>();

  return {
    get: (ticket) => inFlight.get(ticket),
    setLeader: (job) => {
      inFlight.set(job.ticket, { kind: 'leader', job });
    },
    setAttachment: (leader, attachment) => {
      inFlight.set(attachment.ticket, { kind: 'attachment', leader, attachment });
    },
    remove: (ticket) => inFlight.delete(ticket),
    entries: () => inFlight.values(),
    registerWaiter: (ticket, waiter) => {
      const existing = ticketWaiters.get(ticket) ?? [];
      existing.push(waiter);
      ticketWaiters.set(ticket, existing);
    },
    removeWaiter: (ticket, waiter) => {
      const remaining = (ticketWaiters.get(ticket) ?? []).filter((item) => item !== waiter);
      if (remaining.length === 0) {
        ticketWaiters.delete(ticket);
      } else {
        ticketWaiters.set(ticket, remaining);
      }
    },
    waiterCount: (ticket) =>
      ticket === undefined
        ? [...ticketWaiters.values()].reduce((total, waiters) => total + waiters.length, 0)
        : (ticketWaiters.get(ticket)?.length ?? 0),
    notifyWaiters: (ticket) =>
      Effect.gen(function* () {
        const waiters = ticketWaiters.get(ticket) ?? [];
        if (waiters.length === 0) {
          return;
        }
        ticketWaiters.delete(ticket);
        const record = yield* getRequestByTicket(ticket);
        if (record === null) {
          return;
        }
        yield* Effect.forEach(waiters, (waiter) => Deferred.succeed(waiter, record), {
          discard: true,
        });
      }),
  };
};
