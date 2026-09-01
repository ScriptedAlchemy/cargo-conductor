import { describe, expect, it } from '@rstest/core';

import { awaitMaxWaitMs, requestRecordSchema, ticketInputSchema } from '../src/operations/schemas.js';

const baseRecord = {
  argv: ['cargo', 'check'],
  attachMode: null,
  attachedTo: null,
  createdAtMs: 1,
  cwd: '/ws',
  error: null,
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
});

describe('await wait ceiling (issue #3)', () => {
  it('accepts waits beyond the old 15-minute cap up to two hours', () => {
    expect(ticketInputSchema.parse({ maxWaitMs: 3_600_000, ticket: 'cc-1' }).maxWaitMs).toBe(
      3_600_000,
    );
    expect(() => ticketInputSchema.parse({ maxWaitMs: awaitMaxWaitMs + 1, ticket: 'cc-1' })).toThrow();
  });
});
