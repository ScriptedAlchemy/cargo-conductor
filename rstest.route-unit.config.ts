import { fileURLToPath } from 'node:url';

import { defineConfig } from '@rstest/core';
import { agentBundleRstest } from 'agent-bundle/rstest';

/**
 * Route-unit tests run against the framework compiler's own route
 * compilation (manifest, TypeScript transform, RSC conditions) without an
 * artifact build. Plain unit tests stay in `rstest.config.ts`.
 */
const generated = await agentBundleRstest();

export default defineConfig({
  ...generated,
  resolve: {
    alias: {
      // `agent-bundle/meta` throws when imported outside a compiled surface,
      // and route-unit renders import route modules from source (the daemon
      // reads its version from it). Same package.json-backed stand-in as the
      // plain unit config.
      'agent-bundle/meta': fileURLToPath(
        new URL('./tests/fixtures/agent-bundle-meta.ts', import.meta.url),
      ),
    },
  },
});
