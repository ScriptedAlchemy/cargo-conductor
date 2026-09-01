import { readFileSync } from 'node:fs';

import { describe, expect, it } from '@rstest/core';

import { conductorApplication } from '../src/application.js';
import { daemonVersion } from '../src/daemon/main.js';
import { packageVersion } from '../src/lib/version.js';
import { dashboardVersion } from '../views/dashboard-lib.js';

const packageJson = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { readonly version: string };

describe('version consistency', () => {
  it('keeps daemon, application, and dashboard versions aligned with package.json', () => {
    expect(packageVersion).toBe(packageJson.version);
    expect(daemonVersion).toBe(packageJson.version);
    expect(conductorApplication.version).toBe(packageJson.version);
    expect(dashboardVersion).toBe(packageJson.version);
  });
});
