import { describe, expect, it } from '@rstest/core';

import {
  awaitMaxWaitMs,
  awaitResultSchema,
  requestRecordSchema,
  resultFetchResultSchema,
  statusReportSchema,
  statusResultSchema,
  ticketInputSchema,
} from '../src/operations/schemas.js';

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

  it('accepts denied and passthrough terminal request records', () => {
    expect(requestRecordSchema.parse({ ...baseRecord, status: 'denied' }).status).toBe('denied');
    expect(
      requestRecordSchema.parse({ ...baseRecord, status: 'passthrough' }).status,
    ).toBe('passthrough');
  });
});

describe('await wait ceiling (issue #3)', () => {
  it('accepts waits beyond the old 15-minute cap up to two hours', () => {
    expect(ticketInputSchema.parse({ maxWaitMs: 3_600_000, ticket: 'cc-1' }).maxWaitMs).toBe(
      3_600_000,
    );
    expect(() => ticketInputSchema.parse({ maxWaitMs: awaitMaxWaitMs + 1, ticket: 'cc-1' })).toThrow();
  });
});
