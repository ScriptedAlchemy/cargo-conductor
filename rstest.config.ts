import { fileURLToPath } from 'node:url';

import { defineConfig } from '@rstest/core';

export default defineConfig({
  exclude: ['tests/route-unit/**'],
  include: ['tests/**/*.test.ts', 'tests/**/*.eval.ts'],
  resolve: {
    alias: {
      // `agent-bundle/meta` is a compiler-provided constant that throws when
      // imported outside a compiled surface; unit tests import source modules
      // directly, so point the specifier at a package.json-backed stand-in.
      'agent-bundle/meta': fileURLToPath(
        new URL('./tests/fixtures/agent-bundle-meta.ts', import.meta.url),
      ),
    },
  },
  setupFiles: ['./tests/setup/isolate-state.ts'],
  testEnvironment: 'node',
});
