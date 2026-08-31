import { expect, it } from '@rstest/core';

import { conductorStateRoot, reportConductorStatus } from '../src/status.js';

it('reports a stopped daemon at the shared state root', () => {
  expect(reportConductorStatus()).toEqual({
    daemon: 'stopped',
    stateRoot: conductorStateRoot,
    summary: 'cargo-conductor daemon is not running (scaffold).',
  });
});
