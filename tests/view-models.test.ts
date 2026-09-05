import { describe, expect, it } from 'effect-rstest';

import type { LaneStatus, RequestRecord } from '../src/daemon/protocol.js';
import {
  admissionModel,
  buildDiagnosticsModel,
  daemonBadgeModel,
  kacheModel,
  laneBoardModel,
  lineageLine,
  lineageModel,
  ticketCardModel,
} from '../src/components/view-models.js';

/**
 * The view-models are the one derivation every component renders from, so
 * they are pinned here without React: the same strings reach the MCP
 * document, the CLI Markdown, and the dashboard reader.
 */
const nowMs = 1_800_000_000_000;

const record = (overrides: Partial<RequestRecord> = {}): RequestRecord => ({
  after: [],
  argv: ['/home/me/.cargo/bin/cargo', 'check', '-p', 'foo'],
  attachMode: null,
  attachedTo: null,
  background: false,
  createdAtMs: nowMs - 65_000,
  cwd: '/home/me/work/ws',
  diagnostics: null,
  error: null,
  errorCount: null,
  estimateMs: 120_000,
  execArgv: null,
  exitCode: null,
  finishedAtMs: null,
  holdStop: false,
  host: 'cursor',
  id: 1,
  intentJson: null,
  intentKey: null,
  laneKey: 'ws:target',
  outputPath: null,
  outputTail: null,
  queuedAtMs: nowMs - 65_000,
  runMs: null,
  session: 'conv-1',
  signal: null,
  startedAtMs: nowMs - 60_000,
  status: 'running',
  targetDir: '/home/me/work/ws/target',
  ticket: 'cc-7',
  waitMs: 5_000,
  warningCount: null,
  workspaceRoot: '/home/me/work/ws',
  ...overrides,
});

describe('daemonBadgeModel', () => {
  it('summarises a running daemon by permits, riders, queue, and lanes', () => {
    const model = daemonBadgeModel(
      { busyLanes: 2, latencyMs: 3, maxConcurrent: 5, pid: 42, queued: 1, riding: 2, running: 3, startedAtMs: nowMs - 3_600_000, state: 'running' },
      nowMs,
    );
    expect(model.headline).toBe('daemon running (pid 42)');
    expect(model.detail).toBe('3/5 permits +2 riding, 1 queued · 2 lanes busy · up since 1h ago');
  });

  it('names every non-running cause', () => {
    expect(daemonBadgeModel({ reason: 'socket-missing', state: 'stopped' }, nowMs).detail).toContain('starts on demand');
    expect(daemonBadgeModel({ reason: 'connection-refused', state: 'stopped' }, nowMs).detail).toContain('stale socket');
    expect(daemonBadgeModel({ reason: 'accept-timeout', state: 'unresponsive', timeoutMs: 750 }, nowMs).detail).toContain('did not accept a connection within 750ms');
    expect(daemonBadgeModel({ reason: 'answer-timeout', state: 'unresponsive', timeoutMs: 750 }, nowMs).detail).toContain('accepted the connection but sent no status');
    expect(daemonBadgeModel({ reason: 'connection-closed', state: 'unresponsive', timeoutMs: 750 }, nowMs).detail).toContain('closed the connection');
    expect(daemonBadgeModel({ detail: 'EACCES: permission denied', reason: 'open-failed', state: 'unreachable' }, nowMs).detail).toContain('EACCES');
    expect(daemonBadgeModel({ reason: 'event-surface', state: 'unprobed' }, nowMs)).toEqual({
      detail: null,
      headline: 'daemon not probed on this surface',
      skew: null,
      state: 'unprobed',
      stateDir: null,
    });
  });

  it('names the state directory it was given and warns when the daemon is another build (#75)', () => {
    const running = { busyLanes: 0, latencyMs: 3, maxConcurrent: 5, pid: 42, queued: 0, riding: 0, running: 0, startedAtMs: nowMs, state: 'running' as const };
    const model = daemonBadgeModel({ ...running, version: '0.4.2' }, nowMs, { cliVersion: '0.4.4', stateDir: '/fast/cache/cargo-hauler' });
    expect(model.stateDir).toBe('/fast/cache/cargo-hauler');
    expect(model.skew).toBe('daemon 0.4.2 ≠ cli 0.4.4 — restart it with `hauler daemon restart`');
    expect(daemonBadgeModel({ ...running, version: '0.4.4' }, nowMs, { cliVersion: '0.4.4' }).skew).toBeNull();
    // A daemon too old to state a version is not accused of anything.
    expect(daemonBadgeModel(running, nowMs, { cliVersion: '0.4.4' }).skew).toBeNull();
  });
});

describe('buildDiagnosticsModel', () => {
  const errorBlock = [
    'error[E0308]: mismatched types',
    '  --> src/lib.rs:10:5',
    '   |',
    '10 |     1u8',
    '   |     ^^^ expected `String`, found `u8`',
    '   = note: expected struct `String`',
    '',
  ].join('\n');
  const warningBlock = 'warning: unused variable: `x`\n  --> src/main.rs:3:9\n\n';
  const summary = 'error: could not compile `foo` (lib) due to 1 previous error; 1 warning emitted\n';

  it('indexes recognised blocks and keeps every block verbatim', () => {
    const model = buildDiagnosticsModel({ diagnostics: [errorBlock, warningBlock, summary], errorCount: 1, warningCount: 1 });
    expect(model.rows).toEqual([
      { code: 'E0308', level: 'error', location: 'src/lib.rs:10:5', message: 'mismatched types' },
      { code: null, level: 'warning', location: 'src/main.rs:3:9', message: 'unused variable: `x`' },
    ]);
    // Spans, expected/found types, and notes survive alongside the index.
    expect(model.verbatim).toContain('expected `String`, found `u8`');
    expect(model.verbatim).toContain('= note: expected struct `String`');
    expect(model.verbatim).toContain(summary);
    expect(model).toMatchObject({ errorCount: 1, warningCount: 1 });
  });

  it('keeps text the parser does not recognise', () => {
    const model = buildDiagnosticsModel({ diagnostics: ['thread panicked at ...\n'], errorCount: null, warningCount: null });
    expect(model.rows).toEqual([]);
    expect(model.verbatim).toBe('thread panicked at ...\n');
  });
});

describe('ticketCardModel', () => {
  it('projects attribution, placement, and admission holds', () => {
    const model = ticketCardModel(
      record({
        admissionHold: { detail: '1 heavy build already running', reason: 'heavy-profile-cap' },
        queue: { aheadTickets: ['cc-6'], headTicket: 'cc-6', position: 1, waitEtaMs: 30_000 },
        startedAtMs: null,
        status: 'queued',
      }),
      nowMs,
    );
    expect(model.command).toBe('cargo check -p foo');
    expect(model.where).toBe('~/work/ws · cursor / conv-1');
    expect(model.queue).toBe('1 ahead behind cc-6, wait ~30.0s; waiting: 1 heavy build already running');
    expect(model.started).toBeNull();
    expect(model.after).toBeNull();
    expect(model.stalled).toBeNull();
  });

  it('says the lane head is overrunning but alive when the queue context flags it (#91)', () => {
    const model = ticketCardModel(
      record({
        queue: {
          aheadTickets: ['cc-6'],
          headElapsedMs: 900_000,
          headEstimateMs: 300_000,
          headEstimateState: 'overrun',
          headTicket: 'cc-6',
          position: 1,
          waitEtaMs: 300_000,
        },
        startedAtMs: null,
        status: 'queued',
      }),
      nowMs,
    );
    expect(model.queue).toBe(
      '1 ahead behind cc-6 (running 15m), wait ~5m; head overrunning its estimate but alive',
    );
  });

  it('shows what a dependent waits for and keeps its prerequisites on the card', () => {
    const blocked = ticketCardModel(
      record({
        after: ['cc-3', 'cc-4'],
        startedAtMs: null,
        status: 'queued',
        waitingFor: [{ elapsedMs: 120_000, estimateMs: 300_000, status: 'running', ticket: 'cc-3' }],
      }),
      nowMs,
    );
    expect(blocked.queue).toBe('waits for cc-3 (running 2m/~5m)');
    expect(blocked.after).toBe('cc-3, cc-4');
    const finished = ticketCardModel(record({ after: ['cc-3'], status: 'done' }), nowMs);
    expect(finished.queue).toBeNull();
    expect(finished.after).toBe('cc-3');
  });

  it('names a stalled leader with its idle window and the kill command (#46)', () => {
    const model = ticketCardModel(
      record({
        quietMs: 58 * 60_000,
        stall: { cpuMs: 3_200, idleMs: 12 * 60_000, since: nowMs - 60_000 },
        startedAtMs: nowMs - 58 * 60_000,
      }),
      nowMs,
    );
    expect(model.stalled).toBe('looks stalled: no CPU for 12m and no output — hauler kill cc-7');
    expect(model.quiet).toBe('no output for 58m');

    const rider = ticketCardModel(
      record({
        attachedTo: 'cc-5',
        orphaned: true,
        stall: { cpuMs: 3_200, idleMs: 12 * 60_000, since: nowMs - 60_000 },
        ticket: 'cc-9',
      }),
      nowMs,
    );
    expect(rider.stalled).toBe(
      'looks stalled: no CPU for 12m and no output; owner disconnected — hauler kill cc-5',
    );
  });
});

describe('laneBoardModel and admissionModel', () => {
  const lanes: LaneStatus[] = [
    { key: 'a', queued: 2, runningTicket: 'cc-7', targetDir: '/home/me/work/ws/target', workspaceRoot: '/home/me/work/ws' },
    { key: 'b', queued: 0, runningTicket: null, targetDir: '/x/target', workspaceRoot: '/x' },
  ];

  it('lists busy lanes with their leader and counts idle ones', () => {
    const model = laneBoardModel(lanes, [record()], nowMs);
    expect(model.idleLanes).toBe(1);
    expect(model.rows).toEqual([
      { executing: null, name: 'ws (target)', queued: 2, running: 'cc-7', runningCommand: 'cargo check -p foo', runningFor: '1m', stalled: null },
    ]);
  });

  it('marks a stalled lane head on its row (#46)', () => {
    const model = laneBoardModel(
      lanes,
      [record({ stall: { cpuMs: 10, idleMs: 15 * 60_000, since: nowMs - 60_000 } })],
      nowMs,
    );
    expect(model.rows[0]?.stalled).toBe('stalled 15m');
  });

  it('reports permits with the heavy cap and a paused gate under hard memory pressure', () => {
    const model = admissionModel({
      active: [record(), record({ status: 'queued', ticket: 'cc-8' })],
      maxConcurrent: 5,
      system: { clampThresholdPerCore: null, cores: 8, heavy: { capActive: true, maxConcurrent: 1, running: 1 }, loadAvg1: 12.5, memClamp: 'hard' },
    });
    expect(model.permits).toBe('1 running of 5 permits (1 heavy, cap 1 under low memory), 1 queued');
    expect(model.load).toBe('load 12.5 on 8 cores');
    expect(model.memory).toBe('pressure hard (admission paused)');
    expect(model.paused).toBe(true);
  });

  it('counts permit holders only and reports riders separately', () => {
    const model = admissionModel({
      active: [
        record(),
        record({ attachedTo: 'cc-1', ticket: 'cc-2' }),
        record({ attachedTo: 'cc-1', ticket: 'cc-3' }),
        record({ status: 'queued', ticket: 'cc-8' }),
      ],
      maxConcurrent: 5,
      system: undefined,
    });
    expect(model.permits).toBe('1 running of 5 permits, 2 riding shared builds, 1 queued');
  });
});

describe('kacheModel and lineageModel', () => {
  it('distinguishes an unreported kache field from a detected absence', () => {
    expect(kacheModel(undefined)).toEqual({ kind: 'unknown' });
    expect(kacheModel({ available: false, distinctCrates: 0, entryCount: 0, eventsFreshMs: null, indexSizeBytes: 0, recentHeartbeatRoots: [], topCrates: [] })).toEqual({ kind: 'unavailable' });
  });

  it('carries the store-pressure lines and warnings beside the index summary', () => {
    const model = kacheModel(
      {
        available: true,
        distinctCrates: 40,
        entryCount: 1_200,
        eventsFreshMs: 5_000,
        indexSizeBytes: 2 * 1024 ** 2,
        recentHeartbeatRoots: [],
        topCrates: [],
        pressure: {
          storeBytes: 541 * 1024 ** 3,
          limit: { kind: 'known', bytes: 429 * 1024 ** 3, source: 'KACHE_MAX_SIZE' },
          gc: {
            kind: 'ran',
            lastRunAtMs: nowMs - 90_000,
            durationMs: 83_000,
            entriesEvicted: 0,
            bytesFreed: 1_050_074,
            diskBytesReclaimed: 0,
            blobsRemoved: 2,
            declined: false,
            entriesPinned: null,
            entriesUnreclaimable: null,
            evictionErrors: 4,
            evictionErrorSample: 'database is locked',
          },
          keyTiming: { count: 3, meanMs: 1_000, p95Ms: 1_100 },
        },
      },
      5,
      nowMs,
    );
    expect(model.kind).toBe('available');
    if (model.kind !== 'available') {
      return;
    }
    expect(model.summary).toBe('1200 entries across 40 crates (2.0 MB)');
    expect(model.pressure).toEqual({
      gc: 'ran 2m ago in 1m 23s, 0 entries evicted, 2 blobs removed, 1.0 MB freed, 4 evictions skipped',
      keyTiming: 'key_ms mean 1.0s · p95 1.1s (n=3)',
      kind: 'available',
      store: { limitSource: 'KACHE_MAX_SIZE', percent: (541 / 429) * 100, text: '541.0 GB of 429.0 GB (126%)' },
      warnings: [
        { kind: 'over-limit', text: 'store is over its limit (541.0 GB of 429.0 GB (126%)); kache GC is not keeping up' },
        { kind: 'gc-eviction-errors', text: 'last GC skipped 4 evictions: database is locked' },
      ],
    });
  });

  it('marks store pressure unavailable for a daemon that predates the report', () => {
    const model = kacheModel(
      { available: true, distinctCrates: 1, entryCount: 1, eventsFreshMs: null, indexSizeBytes: 10, recentHeartbeatRoots: [], topCrates: [] },
      5,
      nowMs,
    );
    expect(model.kind === 'available' ? model.pressure : null).toEqual({ kind: 'unavailable', reason: 'older-daemon' });
  });

  it('describes where a request sits in its conversation tree', () => {
    const model = lineageModel({
      source: 'native',
      state: 'available',
      value: { conversation: 'c2', depth: 1, parent: 'c1', resolution: 'registry', root: 'c1', subagent: { id: 'sub-9', type: 'explore' } },
    });
    expect(model).not.toBeNull();
    expect(lineageLine(model!)).toBe('conversation c2 (depth 1 under c1 via c1 · explore sub-9; registry)');
    expect(lineageModel({ reason: 'not-provided', state: 'unavailable' })).toBeNull();
  });
});
