# Agent instructions

## Build and check

- `pnpm run build` compiles one host pack per target (`artifact/claude`,
  `artifact/codex`, `artifact/cursor`, `artifact/portable`) and the package
  binaries (`dist/bin/hauler.js`, `dist/bin/cargo-hauler.js`,
  `dist/bin/cargo-hauler-install.js`).
- `pnpm run check` is the gate: validate, build, typecheck, Effect
  diagnostics, `rstest`, and the route-unit suite. Run it before claiming a
  change is done.
- The plugin surface is an agent-bundle application: `src/layout.tsx` (the
  shell), `src/providers/hauler-daemon.ts` (daemon connection), `src/components`
  (typed components over `view-models.ts`), `src/mcp/hauler/tools` and
  `src/mcp/hauler/apps` (MCP), `src/events` (hook routes), `src/hooks/fast-path`
  (the declared `tool/before` and `tool/after` shell hooks: decide on the raw
  command, then `import()` the rest — keep them free of React and Effect),
  `src/cli` (routed CLI), `src/scripts/hauler.ts` (process entry),
  `src/skills`. The README's tour is the map; do not reintroduce a
  hand-written server, argv parser, or string-concatenated documents — add a
  component and a view-model.
- Documents must stay honest: a daemon the probe could not reach renders as
  `stopped`/`unresponsive` with its typed reason, never as an empty success.
- Names are `hauler` / `cargo-hauler` / `CARGO_HAULER_*`. No other prefix is
  read; never add an alias.

## Effect version

This branch is **Effect v4** (`effect` 4.0.0-rc.112), not v3. v3 idioms
(`Context.Tag`, `Data.TaggedError`, `@effect/platform` as a separate package)
often do not apply; check the vendored v4 source before assuming an API exists.

## Learning more about Effect

Before writing any Effect code, first read `node_modules/effect/AGENTS.md`
**completely**, and follow the links in the file when required.

If you need to learn more about particular Effect apis and concepts that the
guide doesn't cover, search through the source code in `node_modules/effect/src`
**and** the vendored monorepo at `repos/effect` (the full monorepo at the same
pin; never import from it).

## `repos/` — vendored reference source (read-only)

`repos/effect` is the Effect monorepo vendored as a git subtree, pinned to the
`effect@4.0.0-rc.112` tag — the exact version in `package.json`. It exists so
agents can read real source instead of guessing or searching the web.

Rules:

- **Never edit anything under `repos/`.** It is reference material, not part of
  this codebase. It is updated only by re-running `git subtree pull`.
- **Never import from `repos/` in application code.** Runtime dependencies come
  from `node_modules` via `package.json`. `repos/effect` is not a workspace
  package and is excluded from `tsconfig.json` includes, test globs, and the
  build.
- **Prefer the vendored source over web search.** Web results are dominated by
  Effect v3 and are frequently wrong for this branch. The tree in
  `repos/effect` is the ground truth for 4.0.0-rc.112.
- **Read `repos/effect/LLMS.md` first** when writing Effect code. It is the
  agent-facing guide to v4 idioms (`Effect.gen`, `Effect.fn`,
  `Context.Service`, `Schema.TaggedError`, Layers, testing) and links into
  runnable examples under `repos/effect/ai-docs/`.
- When writing Effect v4 code, inspect `repos/effect/packages/effect/src/` for
  idiomatic usage. `specs/reference/reference-repos.md` indexes the paths that
  matter for this project.
- Migrating v3-shaped code? See `repos/effect/MIGRATION.md`.
