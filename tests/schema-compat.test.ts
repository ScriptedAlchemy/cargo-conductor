import { describe, expect, it } from '@rstest/core';

import {
  awaitMaxWaitMs,
  requestRecordSchema,
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
};

describe('schema forward compatibility (issue #4)', () => {
  it('strips unknown daemon fields instead of rejecting the record', () => {
    const parsed = requestRecordSchema.parse({
      ...baseRecord,
      futureDaemonField: 'added by a newer daemon',
    });
    expect(parsed.ticket).toBe('cc-1');
    expect('futureDaemonField' in parsed).toBe(false);
  });

  it('accepts optional daemon metric snapshots in status results', () => {
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
