import { describe, expect, it } from '@rstest/core';

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
          { error: null, exitCode: 0, status: 'done', ticket: 'cc-7' },
        ],
      }),
    );
    expect(result.outcome).toBe('deny');
    expect(result.reason).toMatch(/cc-7 finished: success/u);
    expect(result.reason).toMatch(/conductor_result cc-7/u);
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
