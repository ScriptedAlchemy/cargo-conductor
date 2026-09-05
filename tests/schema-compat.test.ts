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

/**
 * A settled row exactly as the ledger's row mapper serializes it
 * (`toRequestRecord` in src/daemon/ledger.ts): every column present, the
 * nullable ones null, `after` an empty list. The live-only fields (`queue`,
 * `waitingFor`, `stall`, ...) are overlaid on active rows and absent here.
 */
const baseRecord = {
  after: [],
  argv: ['cargo', 'check'],
  attachMode: null,
  attachedTo: null,
  background: false,
  buildFinishedAtMs: null,
  createdAtMs: 1,
  cwd: '/ws',
  diagnostics: null,
  error: null,
  errorCount: null,
  estimateMs: null,
  execArgv: null,
  exitCode: 0,
  finishedAtMs: 2,
  holdStop: false,
  host: 'cursor',
  id: 1,
  intentJson: null,
  intentKey: null,
  laneKey: '["/ws","/ws/target"]',
  outputPath: null,
  outputTail: null,
  queuedAtMs: 1,
  runMs: 1,
  savedComputeMs: null,
  savedComputeSource: null,
  savedLatencyMs: null,
  session: null,
  signal: null,
  startedAtMs: 1,
  status: 'done',
  targetDir: '/ws/target',
  ticket: 'cc-1',
  waitMs: 0,
  warningCount: null,
  workspaceRoot: '/ws',
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

const histogram = (value: number) => ({
  buckets: [[1_000, 1], [null, 1]],
  count: 1,
  max: value,
  min: value,
  sum: value,
});

/** One window as `metricsWindows` (src/daemon/ledger.ts) returns it; the broker adds the id. */
const metricsWindow = (id: 'hour' | 'day' | 'all') => ({
  id,
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
    { subcommand: 'check', profile: 'dev', count: 7, p50Ms: 900, maxMs: 2_300, phases: null },
    {
      subcommand: 'test',
      profile: 'test',
      count: 5,
      p50Ms: 2_100,
      maxMs: 5_900,
      phases: {
        count: 5,
        compileP50Ms: 1_500,
        executeP50Ms: 600,
        compileTotalMs: 8_000,
        executeTotalMs: 3_200,
      },
    },
  ],
  runTotalMs: 21_600,
  waitTotalMs: 2_400,
  waitSplit: { count: 12, laneBoundMs: 1_800, permitBoundMs: 400, otherMs: 200, permits: 5 },
  handBack: { leaders: 5, laneReleasedMs: 3_200 },
});

const metrics = {
  attach_mode: { identity: 1 },
  attach_rejections: { subcommand: 2 },
  cargo_run_ms: histogram(12),
  cargo_run_ms_by_kind: { check: histogram(12) },
  job_outcome: { done: 1 },
  wait_ms_summary: {
    count: 1,
    max: 500,
    min: 500,
    quantiles: [[0.5, 500], [0.9, 500], [0.95, 500]],
    sum: 500,
  },
  windows: [metricsWindow('hour'), metricsWindow('day'), metricsWindow('all')],
};

const kache = {
  available: true,
  distinctCrates: 2,
  entryCount: 3,
  eventsFreshMs: 750,
  indexSizeBytes: 4_096,
  recentHeartbeatRoots: [{ count: 2, root: '/srv/projects/alpha' }],
  topCrates: [{ crate: 'alpha', ms: 12_000, profile: 'release' }],
  pressure: {
    storeBytes: 2 * 1024 ** 3,
    limit: { kind: 'known', bytes: 20 * 1024 ** 3, source: '/home/me/.config/kache/config.toml' },
    gc: { kind: 'unavailable', reason: 'missing' },
    keyTiming: null,
  },
};

/** `system` with only the fields every platform reports; the /proc and macOS samples are added per test. */
const system = { clampThresholdPerCore: null, cores: 16, loadAvg1: 3.2, memClamp: 'none' };

/** A status report exactly as the daemon answers `status`: the broker's report plus the server's `version`. */
const report = {
  active: [
    { ...baseRecord, exitCode: null, finishedAtMs: null, runMs: null, status: 'running', ticket: 'cc-2' },
  ],
  kache,
  lanes: [
    {
      key: '["/ws","/ws/target"]',
      queued: 0,
      runningTicket: 'cc-2',
      executingTickets: [],
      targetDir: '/ws/target',
      workspaceRoot: '/ws',
    },
  ],
  maxConcurrent: 5,
  metrics,
  pid: 42,
  recent: [baseRecord],
  savings,
  socketPath: '/tmp/cc/daemon.sock',
  startedAtMs: 1,
  system,
  version: '0.6.0',
};

const { version: _daemonVersion, ...reportBody } = report;

/** The `hauler status` document built from a report the probe reached. */
const runningResult = {
  ...reportBody,
  daemon: 'running',
  operation: 'status',
  stateRoot: '/tmp/cc',
  summary: 'running',
};

/** The `hauler status` document when no daemon answered: no report, so none of its sections. */
const stoppedResult = {
  active: [],
  daemon: 'stopped',
  lanes: [],
  maxConcurrent: null,
  operation: 'status',
  pid: null,
  recent: [],
  socketPath: '/tmp/cc/daemon.sock',
  startedAtMs: null,
  stateRoot: '/tmp/cc',
  summary: 'stopped',
};

describe('CLI status filter literal', () => {
  it('spells exactly the protocol request statuses (the validator needs the literal, AB4814)', () => {
    const statusFilter = cliStatusInputSchema.shape.status.unwrap().element;
    expect([...statusFilter.options]).toEqual([...requestStatuses]);
  });
});

describe('status report contract', () => {
  it('parses a full status report from the current daemon', () => {
    const parsed = statusReportSchema.parse(report);
    expect(parsed.version).toBe('0.6.0');
    expect(parsed.metrics).toEqual(metrics);
    expect(parsed.system).toEqual(system);
    expect(parsed.savings).toEqual(savings);
    expect(parsed.kache).toEqual(kache);
    expect(parsed.lanes).toEqual(report.lanes);
    expect(parsed.active[0]?.status).toBe('running');
    expect(parsed.recent[0]?.after).toEqual([]);
    expect(parsed.recent[0]?.outputPath).toBeNull();
    expect(parsed.recent[0]?.savedComputeMs).toBeNull();
  });

  it('rejects a report without the daemon version', () => {
    expect(statusReportSchema.safeParse(reportBody).success).toBe(false);
  });

  it('rejects a report missing any of its sections', () => {
    for (const section of ['kache', 'metrics', 'savings', 'system'] as const) {
      const { [section]: _omitted, ...withoutSection } = report;
      expect(statusReportSchema.safeParse(withoutSection).success).toBe(false);
    }
  });

  it('carries a null kache while kache is disabled or unread', () => {
    expect(statusReportSchema.parse({ ...report, kache: null }).kache).toBeNull();
  });

  it('rejects a record without outputPath or after', () => {
    const { outputPath: _outputPath, ...withoutOutputPath } = baseRecord;
    expect(requestRecordSchema.safeParse(withoutOutputPath).success).toBe(false);
    const { after: _after, ...withoutAfter } = baseRecord;
    expect(requestRecordSchema.safeParse(withoutAfter).success).toBe(false);
  });

  it('rejects a metrics window without its totals and splits', () => {
    for (const field of ['runTotalMs', 'waitTotalMs', 'waitSplit', 'handBack'] as const) {
      const { [field]: _omitted, ...window } = metricsWindow('hour');
      expect(
        statusReportSchema.safeParse({ ...report, metrics: { ...metrics, windows: [window] } }).success,
      ).toBe(false);
    }
  });

  it('lets the status document omit the daemon-only sections when no daemon answered', () => {
    const stopped = statusResultSchema.parse(stoppedResult);
    expect(stopped.daemon).toBe('stopped');
    expect(stopped.metrics).toBeUndefined();
    expect(stopped.system).toBeUndefined();
    expect(stopped.savings).toBeUndefined();
    expect(stopped.kache).toBeUndefined();

    const running = statusResultSchema.parse(runningResult);
    expect(running.metrics?.windows).toHaveLength(3);
    expect(running.system?.memClamp).toBe('none');
    expect(running.savings?.totals.savedComputeMs).toBe(16_800);
    expect(running.kache?.pressure.limit).toEqual(kache.pressure.limit);
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
    for (const status of requestStatuses) {
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
    // The flag is overlaid on in-flight rows only; a settled row has none.
    const settled = resultFetchResultSchema.parse({
      operation: 'result',
      request: diagnosedRecord,
      summary: 'cc-1 failed',
      ticket: 'cc-1',
    });
    expect(settled.request?.outputTailLive).toBeUndefined();
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

    // Live fields are overlaid while a request is active; a settled row carries none.
    const settled = requestRecordSchema.parse(baseRecord);
    expect(settled.queue).toBeUndefined();
    expect(settled.delayed).toBeUndefined();
    expect(settled.quietMs).toBeUndefined();
    expect(settled.stall).toBeUndefined();
    expect(settled.orphaned).toBeUndefined();
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
    // Estimates and phase are computed for in-flight rows only.
    const settled = requestRecordSchema.parse(baseRecord);
    expect(settled.compileEstimateMs).toBeUndefined();
    expect(settled.estimateState).toBeUndefined();
    expect(settled.phase).toBeUndefined();

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

  it('accepts --after prerequisites and their live wait state', () => {
    const dependent = requestRecordSchema.parse({
      ...baseRecord,
      after: ['cc-3', 'cc-4'],
      status: 'queued',
      waitingFor: [{ elapsedMs: 1_000, estimateMs: 5_000, status: 'running', ticket: 'cc-3' }],
    });
    expect(dependent.after).toEqual(['cc-3', 'cc-4']);
    expect(dependent.waitingFor?.[0]?.ticket).toBe('cc-3');
    // `after` is stored on every row; `waitingFor` is overlaid only while prerequisites are unsettled.
    const settled = requestRecordSchema.parse(baseRecord);
    expect(settled.after).toEqual([]);
    expect(settled.waitingFor).toBeUndefined();
  });

  it('accepts diagnosed records in status report active/recent lists', () => {
    const parsed = statusReportSchema.parse({
      ...report,
      active: [{ ...diagnosedRecord, status: 'running' }],
      recent: [diagnosedRecord],
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

describe('daemon-sourced payload shape (issue #4)', () => {
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

  it('strips record keys the schema does not declare instead of rejecting the row', () => {
    // The ledger's row mapper also emits `buildFinishedAtMs`, a stamp only the
    // metrics windows summarize; the record schema leaves it out, so it is
    // dropped at the client boundary.
    const parsed = requestRecordSchema.parse(baseRecord);
    expect(parsed.ticket).toBe('cc-1');
    expect('buildFinishedAtMs' in parsed).toBe(false);
  });

  it('round-trips the metrics windows with their per-population phase splits', () => {
    const parsed = statusResultSchema.parse(runningResult);
    expect(parsed.metrics?.cargo_run_ms_by_kind.check?.count).toBe(1);
    expect(parsed.metrics?.attach_rejections).toEqual({ subcommand: 2 });
    expect(parsed.metrics?.wait_ms_summary.quantiles).toEqual([
      [0.5, 500],
      [0.9, 500],
      [0.95, 500],
    ]);
    expect(parsed.metrics?.windows[0]).toEqual(metricsWindow('hour'));
    expect(parsed.metrics?.windows.map((window) => window.id)).toEqual(['hour', 'day', 'all']);
  });

  it('round-trips kache status with its store pressure, and null while kache is disabled', () => {
    const result = statusResultSchema.parse(runningResult);
    expect(result.kache).toEqual(kache);
    const disabled = statusResultSchema.parse({ ...runningResult, kache: null });
    expect(disabled.kache).toBeNull();
  });

  it('round-trips attachment savings aggregates', () => {
    const result = statusResultSchema.parse(runningResult);
    expect(result.savings?.totals.savedComputeMs).toBe(16_800);
    expect(result.savings?.byMode.map((mode) => mode.mode)).toEqual(['identity', 'coverage', 'batch']);
  });

  it('round-trips disk/io pressure fields and accepts their absence', () => {
    const withIo = statusResultSchema.parse({
      ...runningResult,
      system: {
        ...system,
        disks: [{ device: 'nvme0n1p2', utilPercent: 63.2 }],
        ioWaitPercent: 12.5,
      },
    });
    expect(withIo.system?.ioWaitPercent).toBe(12.5);
    expect(withIo.system?.disks).toEqual([{ device: 'nvme0n1p2', utilPercent: 63.2 }]);

    // A daemon without an honest sample (first report, macOS, Windows)
    // omits the fields entirely rather than sending zeros.
    const withoutIo = statusResultSchema.parse({
      ...runningResult,
      system: { ...system, clampThresholdPerCore: 1.5 },
    });
    expect(withoutIo.system?.ioWaitPercent).toBeUndefined();
    expect(withoutIo.system?.disks).toBeUndefined();
  });

  it('round-trips memory pressure fields; memClamp is always present, the samples per platform', () => {
    const withMemory = statusResultSchema.parse({
      ...runningResult,
      system: {
        ...system,
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

    // No PSI, MemAvailable, or macOS level where the platform has none; the clamp verdict is still sent.
    const withoutSamples = statusResultSchema.parse(runningResult);
    expect(withoutSamples.system?.memClamp).toBe('none');
    expect(withoutSamples.system?.memAvailableBytes).toBeUndefined();
    expect(withoutSamples.system?.memPressureLevel).toBeUndefined();

    const { memClamp: _memClamp, ...withoutClamp } = system;
    expect(statusResultSchema.safeParse({ ...runningResult, system: withoutClamp }).success).toBe(false);
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
