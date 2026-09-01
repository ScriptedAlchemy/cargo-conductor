import { lowerMcpResult } from '@agent-bundle/rsc-runtime';
import { describe, expect, it } from '@rstest/core';

import { createConductorApplication } from '../src/application.js';
import { ConductorResult } from '../src/result.js';

describe('conductor application', () => {
  it('exposes status, log, last, and daemon CLI commands without duplicating exec', () => {
    const application = createConductorApplication();
    const cliNames = application.operations.flatMap((operation) =>
      operation.cli === undefined ? [] : [operation.cli.name],
    );
    expect(cliNames).toEqual(['status', 'log', 'last', 'await', 'result', 'request', 'daemon']);
    expect(application.name).toBe('cargo-conductor');
  });

  it('lowers JSX MCP results without a global React identifier', () => {
    const lowered = lowerMcpResult(
      ConductorResult({
        receipt: {
          active: [],
          daemon: 'stopped',
          lanes: [],
          maxConcurrent: null,
          operation: 'status',
          pid: null,
          recent: [],
          socketPath: '/tmp/cc.sock',
          startedAtMs: null,
          stateRoot: '/tmp/cc',
          summary: 'cargo-conductor daemon is not running',
        },
      }),
    );
    expect(lowered.isError).toBeUndefined();
    expect(lowered.structuredContent).toEqual(
      expect.objectContaining({
        daemon: 'stopped',
        operation: 'status',
      }),
    );
  });
});
