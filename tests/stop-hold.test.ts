import { describe, expect, it } from 'effect-rstest';

import { awaitCeilingMs } from '../src/daemon/protocol.js';
import {
  handleStopHold,
  type PendingTicket,
  type StopHoldServices,
} from '../src/hooks/stop-hold.js';

const pending = (overrides: Partial<PendingTicket> = {}): PendingTicket => ({
  createdAtMs: 1_000,
  estimateMs: 90_000,
  holdStop: true,
  startedAtMs: 2_000,
  status: 'running',
  ticket: 'cc-7',
  ...overrides,
});

const services = (overrides: StopHoldServices = {}): StopHoldServices => ({
  incrementDenyCount: () => 1,
  listPending: async () => [pending()],
  maxDenyCount: 3,
  maxWaitMs: 5,
  nowMs: () => 3_000,
  pruneDenyCounts: () => undefined,
  readDenyCount: () => 0,
  waitForTickets: async () => [],
  ...overrides,
});

describe('stop-hold hook', () => {
  it('allows stop when the session has no holdable tickets', async () => {
    const result = await handleStopHold(
      { sessionId: 'sess-1', stopHookActive: false },
      services({ listPending: async () => [] }),
    );
    expect(result).toEqual({ outcome: 'continue' });
  });

  it('fails open without a session or when the daemon cannot be reached', async () => {
    expect(await handleStopHold({ stopHookActive: false }, services())).toEqual({
      outcome: 'continue',
    });
    expect(
      await handleStopHold(
        { sessionId: 'sess-1' },
        services({
          listPending: async () => {
            throw new Error('down');
          },
        }),
      ),
    ).toEqual({ outcome: 'continue' });
  });

  it('ignores fire-and-forget tickets', async () => {
    const result = await handleStopHold(
      { sessionId: 'sess-1' },
      services({ listPending: async () => [pending({ holdStop: false })] }),
    );
    expect(result).toEqual({ outcome: 'continue' });
  });

  it('denies stop with the result when a ticket finishes during the bounded wait', async () => {
    const result = await handleStopHold(
      { sessionId: 'sess-1', stopHookActive: false },
      services({
        waitForTickets: async () => [
          {
            error: null,
            errorCount: null,
            exitCode: 0,
            status: 'done',
            ticket: 'cc-7',
            warningCount: null,
          },
        ],
      }),
    );
    expect(result.outcome).toBe('deny');
    expect(result.reason).toMatch(/cc-7 finished: success/u);
    expect(result.reason).toMatch(/hauler_result cc-7/u);
  });

  it('denies with ETA and an escape hatch when work is still pending', async () => {
    const result = await handleStopHold(
      { sessionId: 'sess-1', stopHookActive: false },
      services({ waitForTickets: async () => [] }),
    );
    expect(result.outcome).toBe('deny');
    expect(result.reason).toMatch(/cc-7/u);
    expect(result.reason).toMatch(/ETA/u);
    expect(result.reason).toMatch(/stop again/u);
  });

  it('clamps the wait to the daemon await ceiling so an oversized CARGO_HAULER_STOP_WAIT_MS is not rejected', async () => {
    const waits: number[] = [];
    await handleStopHold(
      { sessionId: 'sess-1', stopHookActive: false },
      services({
        listPending: async () => [pending({ estimateMs: awaitCeilingMs * 4 })],
        maxWaitMs: awaitCeilingMs * 3,
        waitForTickets: async (_tickets, maxWaitMs) => {
          waits.push(maxWaitMs);
          return [];
        },
      }),
    );
    expect(waits).toEqual([awaitCeilingMs]);
  });

  it('prunes deny counters for tickets that finished or are no longer pending', async () => {
    const pruned: { readonly keep: readonly string[]; readonly session: string }[] = [];
    const prune = (session: string, keep: readonly string[]): void => {
      pruned.push({ keep, session });
    };
    const result = await handleStopHold(
      { sessionId: 'sess-1', stopHookActive: false },
      services({
        listPending: async () => [pending({ ticket: 'cc-7' }), pending({ ticket: 'cc-8' })],
        pruneDenyCounts: prune,
        waitForTickets: async () => [
          { error: null, errorCount: null, exitCode: 0, status: 'done', ticket: 'cc-7', warningCount: null },
        ],
      }),
    );
    expect(result.outcome).toBe('deny');
    // cc-7 finished during the wait, so only cc-8 keeps its counter.
    expect(pruned).toEqual([{ keep: ['cc-8'], session: 'sess-1' }]);

    // Once the session has nothing pending, everything it owned is released.
    pruned.length = 0;
    await handleStopHold(
      { sessionId: 'sess-1', stopHookActive: false },
      services({ listPending: async () => [], pruneDenyCounts: prune }),
    );
    expect(pruned).toEqual([{ keep: [], session: 'sess-1' }]);
  });

  it('attributes deny increments to the session so pruning stays per session', async () => {
    const bumped: { readonly session: string; readonly ticket: string }[] = [];
    await handleStopHold(
      { sessionId: 'sess-1', stopHookActive: false },
      services({
        incrementDenyCount: (ticket, session) => {
          bumped.push({ session, ticket });
          return 1;
        },
        pruneDenyCounts: () => undefined,
      }),
    );
    expect(bumped).toEqual([{ session: 'sess-1', ticket: 'cc-7' }]);
  });

  it('allows stop after the per-ticket deny cap when stopHookActive is set', async () => {
    const result = await handleStopHold(
      { sessionId: 'sess-1', stopHookActive: true },
      services({
        maxDenyCount: 2,
        readDenyCount: () => 2,
      }),
    );
    expect(result).toEqual({ outcome: 'continue' });
  });
});
