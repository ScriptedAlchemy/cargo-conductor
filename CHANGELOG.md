# Changelog

## 0.4.2

### Patch Changes

- 747f311: Remove `scripts/preview-dashboard.mjs`; preview the dashboard App through `agent-bundle dev` (the Workbench MCP page previews `ui://cargo-hauler/dashboard.html` over its bound session), and point the `hauler-dashboard` skill and README at it (#49)
- c5bfc4b: Add `hauler kill <ticket>` and the `hauler_kill` tool: a queued ticket is dropped, a running one has its cargo process group terminated (SIGTERM, then SIGKILL after `CARGO_HAULER_KILL_GRACE_MS`) and its lane freed, with riders settled by the daemon. The skill and session context now say to use it instead of killing cargo PIDs (#46). The `maxWaitMs` ceiling on `await` is reported in plain words rather than a raw validator payload (#47).
- 5f89f16: Merged-output runs (`cargo run 2>&1`, a shared terminal) strip cargo's captured color when the shared descriptor is not a color-capable TTY, matching direct cargo's `auto`, and the merge is honoured in passthrough runs too. `hauler await` / `hauler_await` subtract the time already spent fetching the ticket snapshot from the daemon wait, so the worst case stays under the render session. A failed run times its own intent for retries but no longer feeds the per-crate priors shared with other intents.

## 0.4.1

### Patch Changes

- 0861873: Align the plugin's remaining hand-synced surfaces with agent-bundle framework mode: the `hauler_status` tool and the dashboard MCP App route now read the widget URI from one imported `APP_RESOURCE_URI` const that the compiler resolves statically (no duplicated `ui://` literals), the App template is declared route-relative, and the unit-test pool takes its `agent-bundle/meta` alias from the framework's `agentBundleRstest` preset instead of a hand-written fixture. No runtime behavior changes.
- 889b430: A ticket settles once its cargo process exits even when a surviving descendant (an orphaned helper or a daemonized child) keeps the output pipe open: the daemon drains for one more second, then stops reading instead of waiting for pipe EOF indefinitely.

## 0.4.0

### Minor Changes

- 5c14816: The plugin layer is now a full agent-bundle application. Every MCP tool, hook, skill, and CLI command keeps its name and semantics; the daemon is unchanged.
  
  - Targets are `claude`, `codex`, `cursor`, and `portable` — one independently installable pack each under `artifact/<host>` (`output.distPath`) — instead of the composite `plugin` bundle. Install with `agent-bundle install <host> --from artifact/<host>` (Cursor `--mode local|marketplace`, `--replace` after a same-version rebuild) or, from an `npm pack`ed tarball, `npx cargo-hauler-install install <host>`; `agent-bundle prepack` gates the tarball, which now carries `artifact/` beside `dist/`. The project ships no installer of its own (cargo-hauler#25).
  - `src/layout.tsx`: the hauler shell around every rendered route — a daemon badge (what the request-start probe proved, with the permit/rider/queue summary), the route's document unchanged, a lineage footer naming the requesting conversation, and `_meta.hauler` (`route`, `surface`, `server`, `version`, `daemon`, `lineage`) on every MCP result.
  - `src/providers/hauler-daemon.ts` replaces `daemon-config`: one request-scoped daemon connection (`config`, `health`, `probedAt`) with typed unavailable states (`stopped: socket-missing | connection-refused`, `unresponsive: accept-timeout | answer-timeout | connection-closed`, `unreachable: open-failed` with the errno, `unprobed: event-surface`). It never fabricates status, and the probe budget bounds the socket accept as well as the answer (`requestOverSocket` gains an optional `openTimeoutMs`).
  - Components over pure view-models: `<TicketCard>`, `<TicketList>`, `<LaneBoard>`, `<AdmissionState>`, `<KacheStats>`, `<LogTail>`, `<BuildDiagnostics>` (an index of cargo `error[E…]`/`warning:` blocks — level/code/message/location — above the verbatim blocks), `<DashboardLink>`, `<DaemonBadge>`, `<LineageFooter>`, `Empty`/`Unavailable`/`Error` states; ticket guidance is one component per status.
  - Streaming: `hauler_await` / `hauler await` render the live ticket card and a progress node while the daemon-side wait blocks, then the settled ticket; `hauler_log` / `hauler log` stream a progress frame before the listing. `structuredContent` and `--json` are unchanged.
  - Attribution uses `request.lineage`: when a host publishes no session id (bare stdio MCP), the calling conversation becomes the ticket's session, so parallel agents' builds are attributable in the ledger, the dashboard, and `hauler status --session` (or the `hauler_status` tool's `session` field). `hauler_request` results carry `attribution` (`host`, `session`, `lineage`).
  - New `session/start` event route: each new Claude, Codex, or Cursor session receives the daemon state and the no-kill rule as additional context.
  - `hauler-dashboard` is a rendered skill (`SKILL.tsx`) computed from the tool and CLI spellings and the App resource URI it describes.
  - Tests: route-unit (layout, streaming, lineage, events), cli-dispatch, script-dispatch, mcp-in-memory against a live fixture broker, workbench-surface, and the packed-stdio contract matrix against `artifact/cursor`.
- f6765a1: Admission caps heavy leaders under low memory (#27): when `MemAvailable` is below `CARGO_HAULER_HEAVY_MEM_AVAILABLE_GB` (default 16 GiB, `off` to disable), at most `CARGO_HAULER_HEAVY_MAX_CONCURRENT` (default 1) release/perf/bench-profile or workspace-wide builds run at once. Held jobs report why in heartbeats, `hauler status`, and the dashboard (`admissionHold`, `heavy` in the load report). `cargo build -r` is now recognized as a release build for intent identity.
  
  Non-compiling cargo subcommands (`fmt`, `update`, `fetch`, `add`, `remove`, `generate-lockfile`, `vendor`, `new`, `init`, `info`, `uninstall`) run locally instead of queueing for a permit.
  
  The `hauler` script inside a host artifact forwards routed commands (`status`, `log`, `last`, `await`, `result`, `request`) to the bundled `bin/cargo-hauler.mjs`, so an installed plugin exposes the full CLI.
  
  agent-bundle re-pinned to preview `4edbd493b`; the framework now provides the `agent-bundle/meta` test alias, script discovery alongside `bin` claims, and same-version installer replacement, so the local workarounds for those are removed.

### Patch Changes

- c6b9bc6: The admission line in `hauler status` and the `hauler_status` tool counts permit holders only; requests riding a shared build are reported separately instead of inflating "running" past the permit cap.
- dce27a7: Bump `agent-bundle` and `@agent-bundle/runtime` to the pkg.pr.new preview of agent-bundle `main` commit `886b192` (`0.0.0-preview-886b192`, previously `4edbd493b`).
- 58a09e1: Paths are canonicalized through their nearest existing ancestor, so a target directory spells the same before and after cargo creates it (macOS `/var` → `/private/var`); lane keys and coverage attachment no longer diverge between a leader and its followers (#35, #36).
- dbfc3c0: `hauler exec` (and the PATH shim) no longer converts a synchronous request to a background ticket on a cold-start estimate: only a measured ETA (`etaSource` `ewma` or `kache`, now carried on the ack) can exceed the host shell cap, so a compile error on a fresh crate reaches the caller instead of exit 0 (#37). When a request is auto-backgrounded it exits `75` (`EX_TEMPFAIL`) and says so; explicit `--bg` keeps exit 0. The shim borrows `CARGO_HAULER_HOST`'s cap when exported, failed runs feed the estimate history, and the client now waits for the daemon's `detach-result` before hanging up so a still-queued ticket is not killed as abandoned.
  
  `hauler await` / `hauler_await` bound one call to 55 s (`maxWaitMs` ceiling), under the framework's 60 s render session; longer waits used to fail with `Agent render elapsed time exceeds 60000ms` and lose the result (#32). Guidance, the skill, and the README say to call again.
  
  Brokered output preserves the program's stdout/stderr write order when the caller's two descriptors are one file (`cargo run 2>&1`, a shared terminal): the client sends `mergeStderr` and the daemon runs the child with stderr on the stdout pipe. Demultiplexed `build`/`check`/`clippy` runs keep separate channels (#38).
- f242bd2: Forward caller environment variables through brokered Cargo executions while filtering cargo-hauler internal settings.
- 929d96c: Publish releases through Changesets and npm trusted publishing with provenance.
- fd3cf6d: When `CARGO_HAULER_STATE_DIR` is too deep for a unix socket path (103 bytes on macOS, 107 on Linux), the daemon socket moves to `$XDG_RUNTIME_DIR` / `$TMPDIR` as `cargo-hauler-<digest>.sock` instead of silently failing to bind; every client resolving the same state dir agrees on the endpoint.

Notable changes per release, newest first. Versions are the `version` field in
`package.json`; releases before 0.3.0 are described by their commit messages in
`git log`.

## Unreleased

- `hauler exec` (shim and hook rewrites) forwards the caller's whole
  environment to the daemon-spawned Cargo, withholding only `CARGO_HAULER_*`
  and legacy `CARGO_CONDUCTOR_*`. Previously only `CARGO_*`, `RUST*`, the C
  toolchain variables, and color variables travelled, so a `build.rs` or test
  reading any other variable built differently through the broker than
  directly (#29). Request identity still digests the build-relevant subset
  only, so coalescing is unchanged.

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
