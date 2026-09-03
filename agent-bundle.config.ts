import { defineConfig } from 'agent-bundle/config';

/**
 * cargo-hauler is a generic per-workspace cargo orchestrator.
 * tracedecay is the first customer; identity is (workspace root, target dir).
 *
 * Everything else is discovered by convention (framework mode):
 * - `src/mcp/hauler/tools/*.tsx` → the `hauler` MCP server's tools;
 *   `src/mcp/hauler/apps/dashboard.tsx` → its MCP App.
 * - `src/events/**` → tool/before, tool/after, and stop event handlers.
 * - `src/cli/**` → the generated `cargo-hauler` routed CLI (package bin).
 * - `src/scripts/hauler.ts` → `scripts/hauler.mjs` in every host artifact
 *   (the hook rewrite target; see `scripts`) and the package `hauler` bin.
 * - `src/providers/daemon-config.ts` → per-request daemon config.
 * - `src/skills/*` → skills.
 * - Version comes from package.json (`agent-bundle/meta` in code).
 *
 * Adapters inject `AGENT_BUNDLE_PLUGIN_ROOT`; daemon state lives under the
 * per-user cache dir (`CARGO_HAULER_STATE_DIR` overrides).
 */
export default defineConfig({
  bin: {
    hauler: './src/scripts/hauler.ts',
  },
  // Claude Code and Codex install via `<cli> plugin marketplace add`; this
  // emits the marketplace manifests those commands read.
  marketplace: true,
  plugin: {
    description:
      'Coalesce, schedule, and stream cargo so concurrent agent sessions share compiles instead of fighting locks.',
    name: 'cargo-hauler',
  },
  runtime: { node: '22.19.0' },
  // Declared explicitly rather than discovered: a `bin` claim removes the
  // module from conventional route discovery, and the artifact script is
  // what the hooks rewrite cargo to (`scripts/hauler.mjs exec …`).
  scripts: {
    hauler: './src/scripts/hauler.ts',
  },
  // `plugin` emits Claude, Codex, and Cursor into one bundle (and AGENTS.md).
  // Listing `claude`/`cursor`/`plugin` together trips AB6017: those names are
  // all 6 chars, and pathInTargetOutputLayout slices by name length, so each
  // target's MCP entries are attributed to the others.
  // `portable` is the workbench playground target (different name length).
  targets: ['plugin', 'portable'],
});
