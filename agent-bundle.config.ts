import { defineConfig } from 'agent-bundle/config';

/**
 * cargo-hauler is a generic per-workspace cargo orchestrator.
 * tracedecay is the first customer; identity is (workspace root, target dir).
 *
 * - `src/mcp/hauler.ts` is the conventional stdio entry (no `entry` field).
 * - `src/cli.ts` is the package bin by convention; declaring it as a script
 *   also ships `hauler` inside every host artifact.
 * - `skills/cargo-hauler/SKILL.md` is discovered by convention.
 * - Adapters inject `AGENT_BUNDLE_PLUGIN_ROOT`; daemon state lives under the
 *   per-user cache dir (`CARGO_HAULER_STATE_DIR` overrides).
 */
export default defineConfig({
  // Claude Code and Codex install via `<cli> plugin marketplace add`; this
  // emits the marketplace manifests those commands read.
  marketplace: true,
  hooks: {
    afterTool: { handler: './src/hooks/after-shell.ts', timeout: 10, tools: ['shell'] },
    beforeTool: { handler: './src/hooks/before-shell.ts', timeout: 10, tools: ['shell'] },
    stop: { handler: './src/hooks/stop-hold.ts', timeout: 900 },
  },
  mcp: {
    servers: {
      hauler: {
        apps: {
          dashboard: {
            entry: './views/dashboard.tsx',
            resourceUri: 'ui://cargo-hauler/dashboard.html',
            template: './views/dashboard.html',
          },
        },
      },
    },
  },
  plugin: {
    description:
      'Coalesce, schedule, and stream cargo so concurrent agent sessions share compiles instead of fighting locks.',
    name: 'cargo-hauler',
    version: '0.1.22',
  },
  runtime: { node: '22.19.0' },
  scripts: {
    hauler: './src/cli.ts',
  },
  // `plugin` emits Claude, Codex, and Cursor into one bundle (and AGENTS.md).
  // Listing `claude`/`cursor`/`plugin` together trips AB6017: those names are
  // all 6 chars, and pathInTargetOutputLayout slices by name length, so each
  // target's MCP entries are attributed to the others.
  // `portable` is the workbench playground target (different name length).
  targets: ['plugin', 'portable'],
});
