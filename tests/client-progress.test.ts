import { describe, expect, it } from '@rstest/core';

import { formatProgressLine } from '../src/client/progress.js';

describe('formatProgressLine', () => {
  it('formats queued, started, heartbeat, and passthrough lines for the agent shell', () => {
    expect(
      formatProgressLine({ kind: 'queued', laneKey: '["/ws","/ws/target"]', position: 2, ticket: 'cc-1' }),
    ).toBe('[cargo-hauler] ticket cc-1 queued (2 ahead)\n');
    expect(formatProgressLine({ kind: 'started', ticket: 'cc-1', waitMs: 150 })).toBe(
      '[cargo-hauler] ticket cc-1 started (waited 150ms)\n',
    );
    expect(formatProgressLine({ kind: 'heartbeat', elapsedMs: 15_000, phase: 'queued', ticket: 'cc-1' })).toBe(
      '[cargo-hauler] ticket cc-1 still queued (15s)\n',
    );
    expect(formatProgressLine({ kind: 'heartbeat', elapsedMs: 30_400, phase: 'running', ticket: 'cc-2' })).toBe(
      '[cargo-hauler] ticket cc-2 still running (30s)\n',
    );
    expect(formatProgressLine({ kind: 'passthrough', reason: 'daemon unreachable' })).toBe(
      '[cargo-hauler] daemon unreachable; running cargo directly\n',
    );
    expect(
      formatProgressLine({
        kind: 'attached',
        leaderTicket: 'cc-1',
        mode: 'batch',
        ticket: 'cc-2',
      }),
    ).toBe(
      '[cargo-hauler] ticket cc-2 attached to cc-1 (batched into a merged multi-package run)\n',
    );
  });
});
