import { defineConfig } from 'agent-bundle/config';

/**
 * cargo-hauler is a generic per-workspace cargo orchestrator.
 * tracedecay is the first customer; identity is (workspace root, target dir).
 *
 * Everything else is discovered by convention (framework mode):
 * - `src/layout.tsx` → the hauler shell around every rendered route
 *   (daemon badge, lane summary, lineage footer, `_meta.hauler`).
 * - `src/mcp/hauler/tools/*.tsx` → the `hauler` MCP server's tools;
 *   `src/mcp/hauler/apps/dashboard.tsx` → its MCP App.
 * - `src/events/**` → session/start and stop event routes (rendered hooks).
 * - `hooks` below → the tool/before and tool/after entries every shell tool
 *   call runs (`src/hooks/fast-path/`), declared rather than routed so a
 *   non-cargo command exits before the rendering runtime is even parsed.
 * - `src/cli/**` → the generated `cargo-hauler` routed CLI (package bin and
 *   `bin/cargo-hauler.mjs` inside every host artifact).
 * - `src/scripts/hauler.ts` → `scripts/hauler.mjs` in every host artifact
 *   (the hook rewrite target) and the package `hauler` bin (see `bin`).
 * - `src/providers/hauler-daemon.ts` → the per-request daemon connection
 *   (config, socket discovery, health).
 * - `src/skills/*` → skills (`SKILL.md` or a rendered `SKILL.tsx`).
 * - Version comes from package.json (`agent-bundle/meta` in code).
 *
 * Adapters inject `AGENT_BUNDLE_PLUGIN_ROOT`; daemon state lives under the
 * per-user cache dir (`CARGO_HAULER_STATE_DIR` overrides).
 */
export default defineConfig({
  bin: {
    hauler: './src/scripts/hauler.ts',
  },
  // The shell hooks (issue #90). An event route ships as a ~3.6 MB wrapper
  // that evaluates the rendering runtime and spawns a Flight worker before the
  // route can look at the command: ~0.1 s and 64 MB with a shared runtime up,
  // ~0.55 s and 144 MB without, on every Bash call, cargo or not. A
  // config-declared handler compiles to a 50–140 KB entry with no React and
  // no Effect (~0.05 s, 48 MB) that the framework hands the decoded event;
  // `src/hooks/fast-path/` answers `continue` for a command that names
  // neither cargo, hauler, nor conductor before evaluating anything else, and
  // runs the rewrite / telemetry modules (inlined, deferred) only for the
  // rest. Same `shell` matcher, same 10 s budget, same hosts as the routes
  // they replace; the framework still owns the envelope, the validation, and
  // every projection but `allow` (see `src/hooks/fast-path/allow-output.ts`).
  hooks: {
    afterTool: {
      handler: './src/hooks/fast-path/shell-after.ts',
      timeout: 10,
      tools: ['shell'],
    },
    beforeTool: {
      handler: './src/hooks/fast-path/shell-before.ts',
      timeout: 10,
      tools: ['shell'],
    },
  },
  // Claude Code and Codex install via `<cli> plugin marketplace add`; this
  // emits the marketplace manifests those commands read.
  marketplace: true,
  // Host packs land in `artifact/<target>`; the npm package build stays in
  // `dist/` (the `bin` entries above require the two to be separate).
  output: { distPath: 'artifact' },
  plugin: {
    description:
      'Coalesce, schedule, and stream cargo so concurrent agent sessions share compiles instead of fighting locks.',
    name: 'cargo-hauler',
  },
  runtime: { node: '22.19.0' },
  // No `scripts` block: `src/scripts/hauler.ts` is a conventional script. The
  // `bin` entry above does not claim it, so the same module ships as the npm
  // `hauler` bin and as `scripts/hauler.mjs` in every host pack — the path
  // the hooks rewrite cargo to (`scripts/hauler.mjs exec …`).
  // One independently installable pack per host (`agent-bundle install
  // <host> --from artifact/<host>`), plus the Agent Plugins `portable` pack
  // that the Workbench playground and standard-native hosts load.
  targets: ['claude', 'codex', 'cursor', 'portable'],
});
