import { describe, expect, it } from 'effect-rstest';

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

  it('formats queued await heartbeats with lane position, running head, and wait ETA', () => {
    expect(
      formatProgressLine({
        command: 'build --release -p tracedecay-cli',
        elapsedMs: 22 * 60_000,
        estimateMs: 12 * 60_000 + 37_000,
        kind: 'heartbeat',
        laneName: 'tracedecay-backlog-sweep-gpt56',
        phase: 'queued',
        queue: {
          aheadTickets: ['cc-1382', 'cc-1383', 'cc-1381'],
          headElapsedMs: 9 * 60_000,
          headEstimateMs: 12 * 60_000 + 37_000,
          headTicket: 'cc-1382',
          position: 3,
          waitEtaMs: 16 * 60_000 + 14_000,
        },
        ticket: 'cc-1384',
      }),
    ).toBe(
      '[cargo-hauler] cc-1384 queued — 3 ahead in tracedecay-backlog-sweep-gpt56 (head cc-1382 running 9m/~12m37s) · wait ~16m14s — build --release -p tracedecay-cli\n',
    );
  });

  it('formats queued await heartbeat variants without inventing head context', () => {
    expect(
      formatProgressLine({
        command: 'check -p cargo-hauler',
        delayed: true,
        elapsedMs: 10 * 60_000 + 1,
        estimateMs: 60_000,
        kind: 'heartbeat',
        laneName: 'cargo-hauler',
        phase: 'queued',
        queue: {
          aheadTickets: [],
          position: 0,
          waitEtaMs: 0,
        },
        ticket: 'cc-9',
      }),
    ).toBe(
      '[cargo-hauler] cc-9 queued — 0 ahead in cargo-hauler · wait ~0s · wait exceeds estimate — lane busy — check -p cargo-hauler\n',
    );

    expect(
      formatProgressLine({
        command: 'check -p cargo-hauler',
        elapsedMs: 95_000,
        estimateMs: null,
        kind: 'heartbeat',
        laneName: 'cargo-hauler',
        phase: 'queued',
        ticket: 'cc-10',
      }),
    ).toBe('[cargo-hauler] cc-10 queued 1m35s — check -p cargo-hauler\n');
  });

  it('tells an auto-backgrounded caller with redirected stdout where the output went (#68)', () => {
    const base = {
      estimateMs: 600_000,
      kind: 'background' as const,
      ticket: 'cc-7',
    };
    expect(
      formatProgressLine({
        ...base,
        auto: { capMs: 540_000, host: 'claude', stdoutRedirected: true },
      }),
    ).toBe(
      '[cargo-hauler] ticket cc-7 estimate (ETA 600s) exceeds the claude shell cap (9m); submitted in background, not run yet (exit 75); your redirected stdout receives no output; read it with `hauler result cc-7 --full`\nRetrieve with: hauler result cc-7\nAwait with: hauler await cc-7\n',
    );
    expect(
      formatProgressLine({
        ...base,
        auto: { capMs: 540_000, host: 'claude', stdoutRedirected: false },
      }),
    ).toBe(
      '[cargo-hauler] ticket cc-7 estimate (ETA 600s) exceeds the claude shell cap (9m); submitted in background, not run yet (exit 75)\nRetrieve with: hauler result cc-7\nAwait with: hauler await cc-7\n',
    );
    // An explicit --bg is not a conversion; the caller chose it.
    expect(formatProgressLine(base)).toBe(
      '[cargo-hauler] ticket cc-7 submitted in background (ETA 600s)\nRetrieve with: hauler result cc-7\nAwait with: hauler await cc-7\n',
    );
  });

  it('names the admission arm holding a lane head at the gate', () => {
    expect(
      formatProgressLine({
        command: 'build --release -p core',
        elapsedMs: 40_000,
        estimateMs: 300_000,
        hold: {
          detail:
            '1 heavy (release/perf/workspace) build already running and MemAvailable 11.2 GiB < 16 GiB',
          reason: 'heavy-profile-cap',
        },
        kind: 'heartbeat',
        laneName: 'core',
        phase: 'queued',
        ticket: 'cc-11',
      }),
    ).toBe(
      '[cargo-hauler] cc-11 queued 40s (est ~5m) · waiting: 1 heavy (release/perf/workspace) build already running and MemAvailable 11.2 GiB < 16 GiB — build --release -p core\n',
    );
  });
});
