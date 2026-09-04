import { defineConfig } from '@rstest/core';
import { agentBundleRstest } from 'agent-bundle/rstest';

/**
 * The framework preset runs one compiler pass and aliases the reserved
 * `agent-bundle/meta` specifier to a generated module carrying exactly the
 * `{ name, packageName, packageVersion, version }` a build would stamp, so
 * source modules such as `src/daemon/main.ts` and `src/layout.tsx` load here
 * with the package identity instead of raising `AB4760`.
 *
 * Only that alias is adopted. The preset's `react-server` pool conditions are
 * for the route-unit level (`rstest.route-unit.config.ts`), which also hosts
 * the workbench-surface proof.
 */
const { resolve } = await agentBundleRstest();

export default defineConfig({
  exclude: ['tests/route-unit/**'],
  include: ['tests/**/*.test.ts', 'tests/**/*.eval.ts'],
  resolve,
  setupFiles: ['./tests/setup/isolate-state.ts'],
  testEnvironment: 'node',
});
