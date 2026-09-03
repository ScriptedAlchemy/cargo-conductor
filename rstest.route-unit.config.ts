import { defineConfig } from '@rstest/core';
import { agentBundleRstest } from 'agent-bundle/rstest';

/**
 * Route-unit tests run against the framework compiler's own route
 * compilation (manifest, TypeScript transform, RSC conditions) without an
 * artifact build. The preset aliases `agent-bundle/meta` to a package.json
 * stand-in for source imports. Plain unit tests stay in `rstest.config.ts`.
 */
export default defineConfig(await agentBundleRstest());
