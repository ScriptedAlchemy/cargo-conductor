import { describe, expect, it } from 'effect-rstest';

import { inputSchema as cliAwaitInputSchema } from '../src/cli/await.js';
import { inputSchema as cliStatusInputSchema } from '../src/cli/status.js';
import { awaitCeilingMs, requestStatuses } from '../src/daemon/protocol.js';
import {
  awaitResultSchema,
  requestRecordSchema,
  resultFetchResultSchema,
  statusReportSchema,
  statusResultSchema,
  statusInputSchema,
  ticketInputSchema,
} from '../src/lib/protocol-schemas.js';

const baseRecord = {
  argv: ['cargo', 'check'],
  attachMode: null,
  attachedTo: null,
  createdAtMs: 1,
  cwd: '/ws',
  diagnostics: null,
  error: null,
  errorCount: null,
  exitCode: 0,
  finishedAtMs: 2,
  host: 'cursor',
  id: 1,
  intentJson: null,
  intentKey: null,
  laneKey: '["/ws","/ws/target"]',
  outputPath: null,
  outputTail: null,
  queuedAtMs: 1,
  runMs: 1,
  session: null,
  signal: null,
  startedAtMs: 1,
  status: 'done',
  targetDir: '/ws/target',
  ticket: 'cc-1',
  waitMs: 0,
  warningCount: null,
  workspaceRoot: '/ws',
  background: false,
  holdStop: false,
  estimateMs: null,
  execArgv: null,
  savedComputeMs: null,
  savedComputeSource: null,
  savedLatencyMs: null,
};

const savings = {
  byMode: [
    {
      mode: 'identity',
      ridersServed: 3,
      savedComputeMs: 12_000,
      savedComputeExactMs: 12_000,
      savedComputeEstimatedMs: 0,
      savedLatencyMs: 2_000,
      negativeLatencyRiders: 0,
    },
    {
      mode: 'coverage',
      ridersServed: 2,
      savedComputeMs: 4_000,
      savedComputeExactMs: 1_000,
      savedComputeEstimatedMs: 3_000,
      savedLatencyMs: -500,
      negativeLatencyRiders: 1,
    },
    {
      mode: 'batch',
      ridersServed: 1,
      savedComputeMs: 800,
      savedComputeExactMs: 0,
      savedComputeEstimatedMs: 800,
      savedLatencyMs: 300,
      negativeLatencyRiders: 0,
    },
  ],
  totals: {
    ridersServed: 6,
    savedComputeMs: 16_800,
    savedComputeExactMs: 13_000,
    savedComputeEstimatedMs: 3_800,
    savedLatencyMs: 1_800,
    negativeLatencyRiders: 1,
  },
};

/**
 * A record exactly as a 0.4.1 daemon serializes it (`git show
 * v0.4.1:src/lib/protocol-schemas.ts`): no `outputPath` (0.4.2, #68), no
 * `after`/`waitingFor` (0.4.4, #45), no `stall`/`orphaned` (0.4.3, #46). A
 * CLI upgraded under a still-running older daemon must read these (#75).
 */
const { outputPath: _legacyOutputPath, ...legacyDaemonRecord } = baseRecord;

const legacyDaemonReport = {
  active: [{ ...legacyDaemonRecord, exitCode: null, finishedAtMs: null, status: 'running', ticket: 'cc-3518' }],
  lanes: [{ key: '["/ws","/ws/target"]', queued: 0, runningTicket: 'cc-3518', targetDir: '/ws/target', workspaceRoot: '/ws' }],
  maxConcurrent: 5,
  pid: 741314,
  recent: [legacyDaemonRecord],
  socketPath: '/home/me/.cache/cargo-hauler/daemon.sock',
  startedAtMs: 1,
  system: { clampThresholdPerCore: null, cores: 16, loadAvg1: 3.2 },
};

describe('legacy daemon replies (issue #75)', () => {
  it('parses a 0.4.1-shaped status report with today\'s schema, defaulting the fields it lacks', () => {
    const parsed = statusReportSchema.parse(legacyDaemonReport);
    expect(parsed.active[0]?.outputPath).toBeNull();
    expect(parsed.active[0]?.after).toEqual([]);
    expect(parsed.active[0]?.waitingFor).toBeUndefined();
    expect(parsed.active[0]?.stall).toBeUndefined();
    expect(parsed.active[0]?.orphaned).toBeUndefined();
    expect(parsed.recent[0]?.outputPath).toBeNull();
    expect(parsed.system?.heavy).toBeUndefined();
    expect(parsed.version).toBeUndefined();
  });

  it('parses a 0.4.1-shaped result and await reply with today\'s schema', () => {
    const result = resultFetchResultSchema.parse({
      operation: 'result',
      request: legacyDaemonRecord,
      summary: 'cc-1 done',
      ticket: 'cc-1',
    });
    expect(result.request?.outputPath).toBeNull();
    const awaited = awaitResultSchema.parse({
      operation: 'await',
      request: legacyDaemonRecord,
      summary: 'cc-1 done',
      ticket: 'cc-1',
      timedOut: false,
    });
    expect(awaited.request?.after).toEqual([]);
  });

  it('carries the daemon version on a status report from a current daemon', () => {
    const parsed = statusReportSchema.parse({ ...legacyDaemonReport, version: '0.4.4' });
    expect(parsed.version).toBe('0.4.4');
  });
});

describe('CLI status filter literal', () => {
  it('spells exactly the protocol request statuses (the validator needs the literal, AB4814)', () => {
    const statusFilter = cliStatusInputSchema.shape.status.unwrap().element;
    expect([...statusFilter.options]).toEqual([...requestStatuses]);
  });
});

describe('status/result contract completeness (issue #16)', () => {
  /**
   * A finished record exactly as the daemon serializes it after a demuxed
   * run: diagnostics populated, counts non-null. The deployed 0.1.9 MCP
   * schemas rejected these keys (`unrecognized_keys: errorCount,
   * warningCount, diagnostics`), stranding completed-ticket evidence that
   * the ledger still held.
   */
  const diagnosedRecord = {
    ...baseRecord,
    diagnostics: ['error[E0308]: mismatched types\n --> src/lib.rs:1:1'],
    errorCount: 1,
    warningCount: 2,
    status: 'failed',
    exitCode: 101,
  };

  it('accepts diagnostics-bearing records under every durable status', () => {
    const statuses = [
      'requested',
      'queued',
      'running',
      'done',
      'failed',
      'killed',
      'denied',
      'passthrough',
    ] as const;
    for (const status of statuses) {
      const parsed = requestRecordSchema.parse({ ...diagnosedRecord, status });
      expect(parsed.status).toBe(status);
      expect(parsed.errorCount).toBe(1);
      expect(parsed.warningCount).toBe(2);
      expect(parsed.diagnostics).toHaveLength(1);
    }
  });

  it('round-trips a diagnosed record through the await handler schema', () => {
    const parsed = awaitResultSchema.parse({
      operation: 'await',
      request: diagnosedRecord,
      summary: 'cc-1 failed',
      ticket: 'cc-1',
      timedOut: false,
    });
    expect(parsed.request?.diagnostics).toHaveLength(1);
    expect(parsed.request?.errorCount).toBe(1);
  });

  it('round-trips a diagnosed record through the result handler schema', () => {
    const parsed = resultFetchResultSchema.parse({
      operation: 'result',
      request: diagnosedRecord,
      summary: 'cc-1 failed',
      ticket: 'cc-1',
    });
    expect(parsed.request?.warningCount).toBe(2);
  });

  it('accepts a live in-progress output tail on the result record', () => {
    const parsed = resultFetchResultSchema.parse({
      operation: 'result',
      request: {
        ...diagnosedRecord,
        outputTail: '   Compiling tracedecay v0.1.0',
        outputTailLive: true,
        status: 'running',
      },
      summary: 'cc-1 running',
      ticket: 'cc-1',
    });
    expect(parsed.request?.outputTailLive).toBe(true);
    // Older daemons never send the flag; records without it still parse.
    const withoutFlag = resultFetchResultSchema.parse({
      operation: 'result',
      request: diagnosedRecord,
      summary: 'cc-1 failed',
      ticket: 'cc-1',
    });
    expect(withoutFlag.request?.outputTailLive).toBeUndefined();
  });

  it('accepts optional queue, delayed-wait, and quiet-output status fields', () => {
    const queued = requestRecordSchema.parse({
      ...baseRecord,
      delayed: true,
      queue: {
        aheadTickets: ['cc-1', 'cc-2'],
        headElapsedMs: 45_000,
        headEstimateMs: 90_000,
        headTicket: 'cc-1',
        position: 2,
        waitEtaMs: 105_000,
      },
      status: 'queued',
    });
    expect(queued.delayed).toBe(true);
    expect(queued.queue?.position).toBe(2);
    expect(queued.queue?.headTicket).toBe('cc-1');

    const running = requestRecordSchema.parse({
      ...baseRecord,
      quietMs: 301_000,
      status: 'running',
    });
    expect(running.quietMs).toBe(301_000);

    const legacy = requestRecordSchema.parse(baseRecord);
    expect(legacy.queue).toBeUndefined();
    expect(legacy.delayed).toBeUndefined();
    expect(legacy.quietMs).toBeUndefined();
    expect(legacy.stall).toBeUndefined();
    expect(legacy.orphaned).toBeUndefined();
  });

  it('accepts the stall report and orphaned flag on a running record (#46)', () => {
    const stalled = requestRecordSchema.parse({
      ...baseRecord,
      orphaned: true,
      stall: { cpuMs: 4_200, idleMs: 720_000, since: 1_700_000_000_000 },
      status: 'running',
    });
    expect(stalled.stall).toEqual({ cpuMs: 4_200, idleMs: 720_000, since: 1_700_000_000_000 });
    expect(stalled.orphaned).toBe(true);
  });

  it('accepts per-phase estimates and the overrun flag on a running record (#91)', () => {
    const overrun = requestRecordSchema.parse({
      ...baseRecord,
      compileEstimateMs: 20_000,
      estimateState: 'overrun',
      executeEstimateMs: 60_000,
      p90Ms: 90_000,
      phase: 'execute',
      status: 'running',
    });
    expect(overrun.compileEstimateMs).toBe(20_000);
    expect(overrun.executeEstimateMs).toBe(60_000);
    expect(overrun.phase).toBe('execute');
    expect(overrun.estimateState).toBe('overrun');
    expect(overrun.p90Ms).toBe(90_000);
    const legacy = requestRecordSchema.parse(baseRecord);
    expect(legacy.compileEstimateMs).toBeUndefined();
    expect(legacy.estimateState).toBeUndefined();
    expect(legacy.phase).toBeUndefined();

    const behindOverrun = requestRecordSchema.parse({
      ...baseRecord,
      queue: {
        aheadTickets: ['cc-1'],
        headElapsedMs: 900_000,
        headEstimateMs: 300_000,
        headEstimateState: 'overrun',
        headPhase: 'execute',
        headTicket: 'cc-1',
        position: 1,
        waitEtaMs: 300_000,
      },
      status: 'queued',
    });
    expect(behindOverrun.queue?.headEstimateState).toBe('overrun');
    expect(behindOverrun.queue?.headPhase).toBe('execute');
  });

  it('accepts --after prerequisites and their live wait state, defaulting older daemons to none', () => {
    const dependent = requestRecordSchema.parse({
      ...baseRecord,
      after: ['cc-3', 'cc-4'],
      status: 'queued',
      waitingFor: [{ elapsedMs: 1_000, estimateMs: 5_000, status: 'running', ticket: 'cc-3' }],
    });
    expect(dependent.after).toEqual(['cc-3', 'cc-4']);
    expect(dependent.waitingFor?.[0]?.ticket).toBe('cc-3');
    // Daemons before `--after` send neither field.
    const legacy = requestRecordSchema.parse(baseRecord);
    expect(legacy.after).toEqual([]);
    expect(legacy.waitingFor).toBeUndefined();
  });

  it('accepts diagnosed records in status report active/recent lists', () => {
    const parsed = statusReportSchema.parse({
      active: [{ ...diagnosedRecord, status: 'running' }],
      lanes: [],
      maxConcurrent: 5,
      pid: 42,
      recent: [diagnosedRecord],
      socketPath: '/tmp/cc/daemon.sock',
      startedAtMs: 1,
    });
    expect(parsed.recent[0]?.diagnostics).toHaveLength(1);
    expect(parsed.active[0]?.status).toBe('running');
  });

  it('accepts follower savings fields on request records', () => {
    const parsed = requestRecordSchema.parse({
      ...diagnosedRecord,
      savedComputeMs: 2_000,
      savedComputeSource: 'estimate',
      savedLatencyMs: -300,
    });
    expect(parsed.savedComputeMs).toBe(2_000);
    expect(parsed.savedComputeSource).toBe('estimate');
    expect(parsed.savedLatencyMs).toBe(-300);
  });
});

describe('schema forward compatibility (issue #4)', () => {
  it('accepts structured status filters that replace CLI jq workarounds', () => {
    expect(
      statusInputSchema.parse({
        commandContains: 'mcp_suite',
        cwd: '/tmp/worktree',
        limit: 100,
        session: 'session-1',
        statuses: ['queued', 'running'],
        tickets: ['cc-260', 'cc-261'],
      }),
    ).toEqual({
      commandContains: 'mcp_suite',
      cwd: '/tmp/worktree',
      limit: 100,
      session: 'session-1',
      statuses: ['queued', 'running'],
      tickets: ['cc-260', 'cc-261'],
    });
  });

  it('strips unknown daemon fields instead of rejecting the record', () => {
    const parsed = requestRecordSchema.parse({
      ...baseRecord,
      futureDaemonField: 'added by a newer daemon',
    });
    expect(parsed.ticket).toBe('cc-1');
    expect('futureDaemonField' in parsed).toBe(false);
  });

  it('accepts status metrics without the additive optional fields', () => {
    const parsed = statusResultSchema.parse({
      active: [],
      daemon: 'running',
      lanes: [],
      maxConcurrent: 5,
      metrics: {
        attach_mode: { identity: 1 },
        cargo_run_ms: {
          buckets: [[1_000, 1], [null, 1]],
          count: 1,
          max: 12,
          min: 12,
          sum: 12,
        },
        job_outcome: { done: 1 },
      },
      operation: 'status',
      pid: 42,
      recent: [],
      socketPath: '/tmp/cc/daemon.sock',
      startedAtMs: 1,
      stateRoot: '/tmp/cc',
      summary: 'running',
    });

    expect(parsed.metrics?.cargo_run_ms.count).toBe(1);
    expect(parsed.metrics?.job_outcome.done).toBe(1);
    expect(parsed.metrics?.wait_ms_summary).toBeUndefined();
    expect(parsed.metrics?.cargo_run_ms_by_kind).toBeUndefined();
    expect(parsed.metrics?.windows).toBeUndefined();
  });

  it('accepts status metrics with wait summary and per-kind histograms', () => {
    const parsed = statusResultSchema.parse({
      active: [],
      daemon: 'running',
      lanes: [],
      maxConcurrent: 5,
      metrics: {
        attach_mode: { identity: 1 },
        cargo_run_ms: {
          buckets: [[1_000, 1], [null, 1]],
          count: 1,
          max: 12,
          min: 12,
          sum: 12,
        },
        cargo_run_ms_by_kind: {
          check: {
            buckets: [[1_000, 1], [null, 1]],
            count: 1,
            max: 12,
            min: 12,
            sum: 12,
          },
        },
        job_outcome: { done: 1 },
        windows: [
          {
            id: 'hour',
            count: 12,
            done: 9,
            failed: 2,
            killed: 1,
            runP50Ms: 1_200,
            runP95Ms: 5_900,
            runMeanMs: 1_800,
            waitP50Ms: 110,
            waitP95Ms: 640,
            bySubcommand: [
              { subcommand: 'check', profile: 'perf', count: 7, p50Ms: 900, maxMs: 2_300 },
              { subcommand: 'test', count: 5, p50Ms: 2_100, maxMs: 5_900 },
            ],
          },
        ],
        wait_ms_summary: {
          count: 1,
          max: 500,
          min: 500,
          quantiles: [[0.5, 500], [0.9, 500], [0.95, 500]],
          sum: 500,
        },
      },
      operation: 'status',
      pid: 42,
      recent: [],
      socketPath: '/tmp/cc/daemon.sock',
      startedAtMs: 1,
      stateRoot: '/tmp/cc',
      summary: 'running',
    });

    expect(parsed.metrics?.cargo_run_ms_by_kind?.check?.count).toBe(1);
    expect(parsed.metrics?.wait_ms_summary?.quantiles).toEqual([
      [0.5, 500],
      [0.9, 500],
      [0.95, 500],
    ]);
    expect(parsed.metrics?.windows?.[0]).toEqual({
      id: 'hour',
      count: 12,
      done: 9,
      failed: 2,
      killed: 1,
      runP50Ms: 1_200,
      runP95Ms: 5_900,
      runMeanMs: 1_800,
      waitP50Ms: 110,
      waitP95Ms: 640,
      bySubcommand: [
        { subcommand: 'check', profile: 'perf', count: 7, p50Ms: 900, maxMs: 2_300 },
        { subcommand: 'test', count: 5, p50Ms: 2_100, maxMs: 5_900 },
      ],
    });
  });

  it('round-trips kache status results while an old daemon schema strips it', () => {
    const report = {
      active: [],
      kache: {
        available: true,
        distinctCrates: 2,
        entryCount: 3,
        eventsFreshMs: 750,
        indexSizeBytes: 4_096,
        recentHeartbeatRoots: [{ count: 2, root: '/srv/projects/alpha' }],
        topCrates: [{ crate: 'alpha', ms: 12_000, profile: 'release' }],
      },
      lanes: [],
      maxConcurrent: 5,
      pid: 42,
      recent: [],
      socketPath: '/tmp/cc/daemon.sock',
      startedAtMs: 1,
    };

    const result = statusResultSchema.parse({
      ...report,
      daemon: 'running',
      operation: 'status',
      stateRoot: '/tmp/cc',
      summary: 'running',
    });
    expect(result.kache).toEqual(report.kache);
    const oldClient = statusReportSchema.omit({ kache: true }).parse(report);
    expect('kache' in oldClient).toBe(false);
  });

  it('accepts additive savings aggregates and lets old schemas omit them', () => {
    const report = {
      active: [],
      lanes: [],
      maxConcurrent: 5,
      pid: 42,
      recent: [],
      savings,
      socketPath: '/tmp/cc/daemon.sock',
      startedAtMs: 1,
    };
    const result = statusResultSchema.parse({
      ...report,
      daemon: 'running',
      operation: 'status',
      stateRoot: '/tmp/cc',
      summary: 'running',
    });
    expect(result.savings?.totals.savedComputeMs).toBe(16_800);
    const oldClient = statusReportSchema.omit({ savings: true }).parse(report);
    expect('savings' in oldClient).toBe(false);
  });

  it('round-trips disk/io pressure fields and tolerates their absence', () => {
    const base = {
      active: [],
      daemon: 'running',
      lanes: [],
      maxConcurrent: 5,
      operation: 'status',
      pid: 42,
      recent: [],
      socketPath: '/tmp/cc/daemon.sock',
      startedAtMs: 1,
      stateRoot: '/tmp/cc',
      summary: 'running',
    };
    const withIo = statusResultSchema.parse({
      ...base,
      system: {
        clampThresholdPerCore: null,
        cores: 16,
        disks: [{ device: 'nvme0n1p2', utilPercent: 63.2 }],
        ioWaitPercent: 12.5,
        loadAvg1: 3.2,
      },
    });
    expect(withIo.system?.ioWaitPercent).toBe(12.5);
    expect(withIo.system?.disks).toEqual([{ device: 'nvme0n1p2', utilPercent: 63.2 }]);

    // A daemon without an honest sample (first report, macOS, Windows)
    // omits the fields entirely rather than sending zeros.
    const withoutIo = statusResultSchema.parse({
      ...base,
      system: { clampThresholdPerCore: 1.5, cores: 16, loadAvg1: 3.2 },
    });
    expect(withoutIo.system?.ioWaitPercent).toBeUndefined();
    expect(withoutIo.system?.disks).toBeUndefined();
  });

  it('round-trips additive memory pressure fields and tolerates older daemons', () => {
    const base = {
      active: [],
      daemon: 'running',
      lanes: [],
      maxConcurrent: 5,
      operation: 'status',
      pid: 42,
      recent: [],
      socketPath: '/tmp/cc/daemon.sock',
      startedAtMs: 1,
      stateRoot: '/tmp/cc',
      summary: 'running',
    };
    const withMemory = statusResultSchema.parse({
      ...base,
      system: {
        clampThresholdPerCore: null,
        cores: 16,
        loadAvg1: 3.2,
        memAvailableBytes: 12 * 1024 ** 3,
        memClamp: 'hard',
        memFullAvg10: 24.5,
        memPressureLevel: 4,
        memSomeAvg10: 30.1,
      },
    });
    expect(withMemory.system).toMatchObject({
      memAvailableBytes: 12 * 1024 ** 3,
      memClamp: 'hard',
      memFullAvg10: 24.5,
      memPressureLevel: 4,
      memSomeAvg10: 30.1,
    });

    const older = statusResultSchema.parse({
      ...base,
      system: { clampThresholdPerCore: null, cores: 16, loadAvg1: 3.2 },
    });
    expect(older.system?.memClamp).toBeUndefined();
    expect(older.system?.memAvailableBytes).toBeUndefined();
  });

  it('accepts denied and passthrough terminal request records', () => {
    expect(requestRecordSchema.parse({ ...baseRecord, status: 'denied' }).status).toBe('denied');
    expect(
      requestRecordSchema.parse({ ...baseRecord, status: 'passthrough' }).status,
    ).toBe('passthrough');
  });
});

describe('await wait ceiling (issues #3, #32)', () => {
  it('bounds one await at the daemon ceiling on the MCP and CLI routes alike', () => {
    // The routes declare their own render budget (agent-bundle#454), so the
    // daemon's wire ceiling is the only bound on one call; `tests/await-budget.test.ts`
    // holds the budget to it.
    expect(ticketInputSchema.parse({ maxWaitMs: awaitCeilingMs, ticket: 'cc-1' }).maxWaitMs).toBe(awaitCeilingMs);
    expect(() => ticketInputSchema.parse({ maxWaitMs: awaitCeilingMs + 1, ticket: 'cc-1' })).toThrow();
    expect(cliAwaitInputSchema.parse({ maxWaitMs: awaitCeilingMs, ticket: 'cc-1' }).maxWaitMs).toBe(awaitCeilingMs);
    expect(() => cliAwaitInputSchema.parse({ maxWaitMs: awaitCeilingMs + 1, ticket: 'cc-1' })).toThrow();
  });
});
