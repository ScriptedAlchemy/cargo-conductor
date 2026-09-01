import { describe, expect, it } from '@rstest/core';

import { createConductorApplication } from '../src/application.js';

describe('conductor application', () => {
  it('exposes status, log, last, and daemon CLI commands without duplicating exec', () => {
    const application = createConductorApplication();
    const cliNames = application.operations.flatMap((operation) =>
      operation.cli === undefined ? [] : [operation.cli.name],
    );
    expect(cliNames).toEqual(['status', 'log', 'last', 'await', 'result', 'request', 'daemon']);
    expect(application.name).toBe('cargo-conductor');
  });
});
