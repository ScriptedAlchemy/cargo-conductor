import { lowerMcpResult } from '@agent-bundle/rsc-runtime';
import { describe, expect, it } from '@rstest/core';

import { createHaulerApplication } from '../src/application.js';
import { HaulerResult } from '../src/result.js';

describe('hauler application', () => {
  it('exposes status, log, last, and daemon CLI commands without duplicating exec', () => {
    const application = createHaulerApplication();
    const cliNames = application.operations.flatMap((operation) =>
      operation.cli === undefined ? [] : [operation.cli.name],
    );
    expect(cliNames).toEqual(['status', 'log', 'last', 'await', 'result', 'request', 'daemon']);
    expect(application.name).toBe('cargo-hauler');
  });

  it('lowers JSX MCP results without a global React identifier', () => {
    const lowered = lowerMcpResult(
      HaulerResult({
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
          summary: 'cargo-hauler daemon is not running',
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
