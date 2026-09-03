# Changelog

Notable changes per release, newest first. Versions are the `version` field in
`package.json`; releases before 0.3.0 are described by their commit messages in
`git log`.

## 0.3.5 (2026-09-03)

Repository hygiene release; no behavior change.

- Daemon, client, hook, and surface code drop narrating comments and unsafe
  casts in favor of runtime narrowing and the direct Effect v4 recovery
  idioms (`catchCauseIf`, `orElseSucceed`, `ignore`).
- Test suites share scoped temp-dir, database, and ledger helpers from
  `tests/harness.ts`; fixture directories are prefixed `cargo-hauler-it-`.
- README, `docs/install.md`, and `AGENTS.md` match the framework-mode layout
  and 0.3.x behavior (install commands, admission controls, `unresponsive`
  state, hook rewrites, the Cursor manifest-hook limitation).
- `scripts/preview-dashboard.mjs` reads from `dist/bin/cargo-hauler.js`
  again; the finished v3→v4 migration skill, unreferenced media, and a dead
  `tsconfig.views.json` are removed. `CHANGELOG.md` is added and shipped.

## 0.3.4 (2026-09-03)

0.3.3 was not released; 0.3.2 went straight to 0.3.4.

- Shell hooks rewrite the Cargo escape hatches agents actually use:
  `env -u X VAR=y cargo …`, `timeout 600 cargo …`,
  `rustup run <toolchain> cargo …`, and `stdbuf -oL cargo …` now go through the
  broker. Only `rustup run` counts as a wrapper; other `rustup` subcommands
  are left alone.
- The `exec` hot path no longer prints Node's SQLite `ExperimentalWarning` or
  the removed `CARGO_CONDUCTOR_STATE_DIR` reminder into agents' tool output;
  the reminder is kept for hand-run commands only.
- Test suites run with a per-worker `CARGO_HAULER_STATE_DIR`, so hook
  recorders and probes cannot write fixtures into the developer's live ledger.

## 0.3.2 (2026-09-03)

- Daemon status gains a third state, `unresponsive`: a socket that exists but
  does not answer within the status budget (raised from 2 s to 5 s) is no
  longer reported as `stopped` while jobs are in flight. The summary, MCP
  document, and dashboard all render it.
- MCP and CLI documents show shim-originated Cargo by basename instead of the
  full real-cargo path, matching the dashboard.

## 0.3.1 (2026-09-03)

- The PATH shim embeds the `~/.cargo/bin/cargo` link itself rather than its
  canonical rustup proxy target; rustup dispatches on `argv[0]`, so the old
  shim ran `rustup check …`.
- `install-shim` refuses unknown flags instead of installing on `--help`.
- Packed-stdio contract test: the built `artifact/plugin` MCP entry runs as a
  real process against an in-process broker and every tool passes the
  framework matrix.
- Effect tests run through `effect-rstest` (`it.live` / `it.effect` own the
  per-test scope; daemons, ledgers, and temp trees are `acquireRelease`
  resources).
- Status summary pluralizes kache entries.

## 0.3.0 (2026-09-03)

- Plugin surface rebuilt on agent-bundle framework mode. Filesystem routes
  replace the `defineOperation` / application / server layer:
  `src/mcp/hauler/{tools,apps}`, `src/events`, `src/cli`, `src/providers`, and
  a `src/scripts/hauler.ts` process entry for `exec`, `install-shim`, and
  `daemon`. Shared document components render the same Agent Documents on MCP
  and CLI; `hauler_await` streams progress. Route-unit, CLI-dispatch, and
  in-memory MCP suites run through `agent-bundle/rstest` without an artifact
  build.
- agent-bundle re-pinned to pkg.pr.new preview `105c65d8f`
  (`@agent-bundle/rsc-runtime` became `@agent-bundle/runtime`). The project
  moved from npm to pnpm because npm 12 refuses pkg.pr.new tarball URLs by
  default. Skills moved to `src/skills`.
- A daemon that takes longer than the 2 s open timeout to accept a socket is a
  `ControlTimeout`, not an unreachable daemon: `exec` retries the connection
  for up to 60 s before falling back to an unbrokered run, and status no
  longer reports a loaded daemon as stopped.
- Cursor installs use the artifact's own `install.mjs`; the hand-rolled
  installer is gone.
- Docs: queued heartbeats carry lane context, delayed-wait flags, and quiet-run
  hints; the host-tuning document was removed.
