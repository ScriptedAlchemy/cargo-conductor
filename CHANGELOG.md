# Changelog

## 0.6.1

### Patch Changes

- 3aded69: Replace the version-skew warnings with a one-version rule, and stop reading the `CARGO_CONDUCTOR_*` names. The CLI, hooks, MCP server, and daemon ship in one npm package, so a daemon from another version is replaced rather than talked to: when `hauler exec`, `hauler request` (and `hauler_request`), a hook rewrite, or `hauler daemon start` reaches a live daemon whose version differs from the running build's, it sends the graceful shutdown request, waits up to 5 s for the old pid to exit, and starts a daemon from this install — the same mechanics as `hauler daemon restart`, which remains the manual, unconditional form. Tickets in flight on the old daemon are not handed over: the new daemon's first ledger pass marks them `killed` with `orphaned by daemon restart`, and callers resubmit. An old daemon that has not exited within the grace is reported, never killed: the call fails with `` cargo-hauler daemon pid N (X.Y.Z) is still running 5s after the shutdown request; not restarted — retry once it has exited, or stop it with `hauler daemon stop` `` and nothing is started; `hauler exec` then runs cargo directly, naming that reason, and `hauler daemon start` exits 1. Read-only surfaces — `hauler status`, `log`, `last`, `result`, `await`, their MCP tools, and the header probe — never replace a daemon; they read the one that is there. Removed with the skew subsystem: the `daemon 0.4.2 ≠ cli 0.4.4 — restart it with …` line in document headers, in the session-start notice, and in the status summary; the `daemonVersion` field of `hauler status --json` and the `hauler_status` result (`pid`, `startedAtMs`, and the rest are unchanged); the `daemon is 0.4.1 (pid N, since 3h ago), this CLI is 0.4.4 — restart …` failure and its "first mismatch" second line; the extra `ping` that asked a daemon for the version its status report did not carry (every report carries `version`); and the lenient client schemas — `outputPath` and `after` are required again, read exactly as the same-version daemon sends them. The dashboard tiles that could read "unavailable from an older daemon" no longer have that state, and the one-time recompute of attachment savings on ledger rows written before 0.5 no longer runs (those rows keep the numbers they have). `CARGO_CONDUCTOR_*` is no longer read; set `CARGO_HAULER_*`: `CARGO_CONDUCTOR_MAX_CONCURRENT`, `CARGO_CONDUCTOR_KACHE_INDEX`, `CARGO_CONDUCTOR_REPLAY_BUFFER_BYTES`, `CARGO_CONDUCTOR_JOBS_GRANT`, `CARGO_CONDUCTOR_BATCH`, `CARGO_CONDUCTOR_BATCH_WINDOW_MS`, `CARGO_CONDUCTOR_LOAD_THRESHOLD`, `CARGO_CONDUCTOR_LOAD_MIN`, `CARGO_CONDUCTOR_CPU_PRESSURE_THRESHOLD`, `CARGO_CONDUCTOR_KILL_GRACE_MS`, `CARGO_CONDUCTOR_LOG_LEVEL`, `CARGO_CONDUCTOR_STOP_WAIT_MS`, `CARGO_CONDUCTOR_CARGO_BIN`, `CARGO_CONDUCTOR_HOST`, and `CARGO_CONDUCTOR_SESSION` are ignored, the generated PATH shim checks only `CARGO_HAULER_INSIDE`, the stderr warning about an exported `CARGO_CONDUCTOR_STATE_DIR` is gone, and `conductor` is no longer a word the shell hooks treat as a cargo mention — only `cargo` and `hauler` are. (#105)

## 0.6.0

### Minor Changes

- cfb8d3c: Make coverage attachment fire in practice, say why it did not, and let a compile-only `cargo test --no-run` ride a running `cargo test`.
  
  - A `test --no-run` / `bench --no-run` submitted while a `test` / `bench` with the same packages, target selection, features, and profile is in flight in the lane attaches to it and is released — `done`, exit 0, with the leader's compile time so far as its saved compute — the moment the leader prints Cargo's `Finished` line, while the leader goes on running its tests. The leader's test filters, `--test-threads`, and `--no-fail-fast` do not disqualify the rider; a `--lib` rider never attaches to a `--test foo` leader, or a named-target rider to a default-target one. A leader whose build fails requeues the rider through the existing failed-stronger path; a leader that never reports its build finished (`--quiet`, `CARGO_HAULER_OVERLAP_EXECUTION=0`) releases it at settlement. A rider that arrives after the leader's build already finished is refused (`leader-build-finished`) and runs its own, mostly fresh, cargo at once. Both rows carry `buildFinishedAtMs`. (#88)
  - Coverage gates widened where safe: flags the daemon does not model (`--locked`, `--offline`, `--message-format`, …) and arguments after `--` disqualify a `check` riding a `build` / `check` only when they differ between the two requests; `check --tests` rides `build --tests` / `build --all-targets`; a `--bin X` / `--example X` rider rides a `--bins` / `--examples` leader. `check` still never rides `clippy` (a lint failure would misreport the check), a `-p` rider is still not proven by a leader compiling its unnamed default package set, and `--tests` does not stand in for a named `--test X`. (#89)
  - Every refused attachment is logged at debug level (`attach rejected`) with the gate — `subcommand`, `opaque-arguments`, `passthrough`, `compile-surface`, `packages`, `targets`, `channels`, `leader-build-finished` — a one-line detail, and both tickets; the status report counts one refusal per request under `metrics.attach_rejections`, keyed by the nearest gate any leader reached (`hauler status --json`, `hauler_status`). (#89)
- d5ae3e9: Show what the hauler costs, not only what it saves: queue wait vs run time per metrics window, the compile/execute split per command, and kache store pressure. (#92)
  
  - Each metrics window (`1h`, `24h`, `all`) now reports total queue wait against total run time for leaders, and splits the wait by cause: *lane-bound* (a same-lane leader was still compiling — before its `Finished` line or exit), *permit-bound* (every admission permit was held and no same-lane compile was to blame), and *other* (admission holds, `--after` prerequisites, scheduling latency). The classification is a pure sweep over ledger rows, run against the daemon's current permit count; the tile states that assumption, since runs admitted under an earlier cap are classified against today's.
  - With `buildFinishedAtMs` on the row, the by-command split adds compile vs execution p50s for `test`/`run`/`bench` leaders, and the window reports the lane time the execution-phase hand-back released. Pure compiles have no split and say nothing.
  - The kache panel (`hauler status`, `hauler_status`, and the dashboard) surfaces store pressure: blob bytes recorded in the index against `local_max_size` (from `KACHE_MAX_SIZE` or kache's `config.toml`; "limit unknown" names why when it cannot be read), the last GC from `gc_stats.json` — when, how long, what it evicted — with any `gc: skipping eviction` warnings matched from kache's `auto-gc.log`/`daemon.log` during that run, and `key_ms` mean/p95 over the events tail. Warnings appear when the store is over its limit or the last GC declined or skipped evictions. Missing or unparsable files render as unavailable with their reason, never as an empty store.
  - Protocol additions are optional fields (`metrics.windows[].waitSplit`, `handBack`, `runTotalMs`, `waitTotalMs`, `bySubcommand[].phases`, `kache.pressure`); clients reading an older daemon see the tiles as unavailable rather than as zeros.
- ec9bf65: Fold more queued work into one Cargo run: compile batches with a `--` trailer, and test runs whose filters differ.
  
  - `cargo build` / `check` / `clippy` requests with the same arguments after `--` now batch: `cargo clippy -p a -- -D warnings` and `cargo clippy -p b -- -D warnings` run as `cargo clippy -p a -p b -- -D warnings`, the trailer once. Such runs are demultiplexed like any other compile (the `--message-format` rewrite goes before the `--`), so under `-D warnings` a participant whose own units compiled cleanly is released as done when another participant's warnings fail the composite; the rest rerun alone. Trailers that differ, or a trailer on one side only, still keep the runs apart, as do differing `--all-targets` / `--tests` / `--features`. (#86)
  - `cargo test` requests naming different packages fold even when their bare name filters differ: `cargo test -p a -- f1` and `cargo test -p b -- f2` run as `cargo test -p a -p b --no-fail-fast -- f1 f2`, the union of packages with the union of filters. An identical set of `--test-threads=N`, `--nocapture`, `--quiet` (or `-q`) after `--` folds too, carried once from the leader; a mismatched set does not, and `--exact`, `--skip`, `--ignored`, `--include-ignored`, `--list`, `--format`, `--logfile`, or any other harness flag keeps a run out of composites. `--lib` runs fold like `--test NAME` runs; the target selection still has to match. Requests naming the same packages still need the same filters, and unfiltered runs fold only with unfiltered runs. A folded participant inherits a composite failure only when it asked for every package and every filter the composite ran; otherwise it reruns alone. (#87)
- c27662d: Estimate compile and execute separately, and keep a realistic queue ETA when a live head overruns.
  
  `hauler status` reports `compileEstimateMs`, `executeEstimateMs`, and the current `phase` on a ticket. Followers waiting on a `test`/`nextest`/`bench`/`run` head see only the remaining execution time in `queue.waitEtaMs` (zero once overlap has handed the lane back), and queued tickets ahead of them count only their compile when overlap will hand the lane back. A head that has passed `CARGO_HAULER_STALL_ESTIMATE_FACTOR` times its estimate but is still burning CPU or printing is flagged `estimateState: overrun` with the intent's p90 (`p90Ms`), and its followers see `queue.headEstimateState: overrun`; its remaining time is re-estimated from that p90 — never less than one more estimate's worth — instead of contributing zero to the queue. A silent no-CPU head stays `stalled`. Filtered `--test <name>` runs with no history of their own borrow a same-package neighbor's timing before falling back to the crate-wide prior.

### Patch Changes

- f01833d: Cut what the hooks cost every shell tool call. The `tool/before` and `tool/after` hooks are now declared handlers compiled into standalone entries (`hooks/before-tool-shell-before-*.mjs`, `hooks/after-tool-shell-after-*.mjs`) instead of event routes that loaded the whole rendering runtime before looking at the command. `tool/before` reads `tool_input.command` and answers `continue` at once when it has no `cargo`, `hauler`, or `conductor` word (word-boundary aware; `mycargo` and `CARGO_HOME=… ls` do not match, `~/.cargo/bin/cargo`, `cargo-hauler`, and `echo cargo` do — a doubtful command takes the full path). `tool/after` runs that test plus one bounded 500 ms socket ping (`session-completed` with the session's hook-state cursor, no Effect runtime), and loads the telemetry and notification code only when the command was cargo-related or the daemon reported finished tickets; with no daemon it exits quietly with no output. Rewrite, `cargo clean` denial, `hauler exec` pass-through, and completion notices are unchanged. Measured with `/usr/bin/time -v`, median of 5, Claude `ls -la` envelope: `tool/before` 0.05 s / 48 MB and `tool/after` 0.05 s / 49 MB, against 0.54 s / 143 MB and 0.56 s / 144 MB for the 0.5.0 wrappers without a shared runtime (0.10 s / 64 MB with one, per #90); a `cargo test -p foo` envelope is 0.05 s / 49 MB either way. (#90)

## 0.5.0

### Minor Changes

- b80d9db: Cut the latency the hauler adds on a shared target directory, and stop charging lane wait to attaching.
  
  - A lane now hands its slot to the next request as soon as a `test`, `nextest`, `bench`, or `run` leader prints Cargo's `Finished … target(s)` line: Cargo drops the build-directory lock there, so the next compile overlaps the leader's test run instead of waiting for it. The leader keeps its admission permit until it settles. `hauler status` and the dashboard list such leaders under the lane's `executing` tickets, and the ledger stamps `buildFinishedAtMs` on the leader and its riders. `CARGO_HAULER_OVERLAP_EXECUTION=0` restores strict one-process-per-lane.
  - Default admission permits scale with the machine: one per eight cores, clamped between the previous five and sixteen. `CARGO_HAULER_MAX_CONCURRENT` still overrides.
  - The cost model times edited and cached runs of an intent separately, and floors an edited intent that has only ever been timed cached at the crate compile priors, so a recompiling test run no longer reaches the head of the lane on a seconds-long estimate; unedited runs no longer teach the per-crate compile priors.
  - Saved latency for riders is measured from the later of the rider's creation and the leader's start: time queued behind a leader that had not started is lane wait the rider would have paid alone, not a cost of attaching. Existing ledgers recompute the column once on open (`user_version` 2); the dashboard's all-time latency tile changes accordingly.

## 0.4.9

### Patch Changes

- 395cee0: Re-pin `agent-bundle` and `@agent-bundle/runtime` to the `c2ffe5ec5` preview and drop the workarounds it retires. `hauler await` and `hauler_await` wait up to the daemon's 2 h ceiling in one call (`maxWaitMs` ≤ 7200000): the routes declare `config.render.maxElapsedMs` instead of clamping every wait to 55 s, and the await guidance names that ceiling; a host with its own per-call deadline (Codex `tool_timeout_sec`) still bounds one call. The `tool/before`, `tool/after`, and `stop` hook routes read the framework's canonical event payload (`sessionId`, `toolInput`, `toolResponse`, `reentry`) instead of parsing Claude, Codex, and Cursor keys themselves; the never-prompt semantics are unchanged — `allow` only for a fully hauler-governed rewrite, `continue` otherwise, never `ask`. `hauler exec` shapes color, `2>&1` merging, and the redirected-stdout notice from the terminal the executable envelope hands `main`, no longer probing `process.stdout` itself. Ticket lineage accepts the runtime's `transcript` resolution. The rendered `hauler-dashboard` Skill names the release version again. New: `hauler dashboard [--target HOST] [--port N] [--no-open]` serves the dashboard App in a plain browser tab against the running daemon (through `agent-bundle serve-app`, from the checkout or the npm package). (#83)
- 23b3bb8: MCP server stands by instead of exiting when another session owns the event-runtime socket; takes over when it exits (agent-bundle #559/#561). Every host session launches its own `hauler` MCP server from the same installed pack, and only one of them can own the pack's event-runtime Unix socket. Until now the second server exited before answering `initialize` (`Event runtime endpoint already has a live server.`), so a second concurrent Claude Code, Codex, or Cursor session saw no `hauler_*` tools at all. Rebuilt against the `agent-bundle` / `@agent-bundle/runtime` preview of main commit `cd0b4a62c`: a server that finds the socket owned now starts in the standby role, serves its own MCP session, probes the socket about once a second, and takes it over when the owner exits — both transitions are announced on stderr only (`… is owned by another process; standing by`, `… was released by its owner; took it over`), and a takeover failure other than "still owned" is reported there too. Development only: the `@agent-bundle/runtime` preview now depends on the same-commit preview of `rsc-markdown-stream`, so `pnpm-workspace.yaml` sets `blockExoticSubdeps: false` for the build; the published package still declares no runtime dependencies. (#85)

## 0.4.8

### Patch Changes

- 3ad6b7e: Declare no runtime `dependencies`: `npm install -g cargo-hauler` fetches one tarball and nothing else. 0.4.7 listed the build-time stack (`@agent-bundle/runtime` as a pkg.pr.new tarball, `bashjsast` as a `github:` ref, `effect`, `react`, `zod`, …) under `dependencies` even though every shipped file bundles what it uses, so npm 12's default `allow-remote=none` / `allow-git=none` refused the install (`EALLOWREMOTE` for the tarball, `EALLOWGIT` for the git ref). The whole stack now lives under `devDependencies`; the emitted packs and `dist/bin` executables are unchanged. (#82)

## 0.4.7

### Patch Changes

- f13360f: Internal simplification sweep: one socket-errno walker (`src/lib/socket-errors.ts`) serves the client, the health probe, and the hooks; `defaultCargoProfile`, the ms clamps, and `diagnosticCounts` are shared instead of copied; request statuses and attach modes are one `as const` list that feeds the types, the zod schemas, and the ledger's SQL filters; the ack is the broker's `SubmitResult` spread once; the before-shell hook skips the bash parse for commands that cannot name cargo, and the after-shell hook no longer rewrites its state file when no ticket finished. The `hauler await` heartbeat spells whole minutes as `2m` rather than `2m0s`.

## 0.4.6

### Patch Changes

- 4257982: Survive a CLI or plugin upgrade under a daemon left running from the older install, and add `hauler daemon restart`. The client schemas now default the fields older daemons never send (`outputPath`, `after`), so `hauler status`, `hauler result`, `hauler await`, and the `hauler_*` tools read a 0.4.1 daemon's replies instead of printing a Zod issue array; a reply that still cannot be read fails as `daemon is 0.4.1 (pid N, since 3h ago), this CLI is 0.4.4 — restart it with \`hauler daemon restart\`` with the first mismatch (`active[0].outputPath expected string, received undefined`) on a second line, and `hauler daemon status` says the same. The status report carries the daemon `version` (older daemons are asked with one `ping`), `hauler status --json` exposes it as `daemonVersion`, and every document header — plus the status summary — warns `daemon 0.4.2 ≠ cli 0.4.4 — restart it with \`hauler daemon restart\`` while the versions differ. `hauler daemon restart` sends the graceful stop, waits up to 5 s for the old pid to exit, starts a daemon from this install, and prints both pids and versions (`previousPid` in the JSON result; exit `1` when the old daemon did not exit, in which case nothing is started). Tickets in flight at a restart are not handed over: the new daemon marks them `killed` with `orphaned by daemon restart`, and `hauler result` / `hauler_result` explain that instead of showing a plain kill. The shell header ends with `state dir <path>` so a moved `CARGO_HAULER_STATE_DIR` is visible on every command. (#75)

## 0.4.5

### Patch Changes

- 62d4e16: Add `--after <ticket>[,<ticket>…]` to `hauler exec` and `hauler request` (and `after: string[]` on `hauler_request`) to declare explicit ticket dependencies: the request stays `queued` — skipped by lane admission and batch folding — until every named ticket has settled, fails with `prerequisite cc-N failed`/`killed` (exit code `null`) if one of them does, resolves at once when they already finished, and is rejected as a `bad-intent` error naming an unknown ticket. Prerequisites may live in another lane; the ledger stores them (`after` on every request record) and `hauler status`/`hauler result`/await heartbeats show `waits for cc-N (running 2m/~5m)` while a dependent is held. The `exec --bg` and `request` acknowledgements now name the tickets ahead in the lane (`queued behind cc-3281 (~13m)`, `ahead` on the ack and `queue` on the request result) so a cost-ordered reorder is visible, and `hauler request` reports the daemon's rejection reason instead of a generic submit failure. (#45)
- 1135585: The daemon rejects a path-shaped program that is not cargo (`bad-intent`) instead of running it and recording the path as the subcommand; the dashboard's by-command table shows legacy rows by basename, and the all-time latency tile reads "latency added by attaching" when riders waited longer than their solo estimate instead of showing a negative "saved" value. Dashboard screenshots refreshed.
- d86d8b6: The shared fifo jobserver is armed only when the host `make` can speak it (GNU make 4.4+, or no make at all); on older makes the daemon falls back to per-run `CARGO_BUILD_JOBS` grants so `-sys` crates whose build scripts run `make` (jemalloc, openssl, …) build again. `CARGO_HAULER_JOBSERVER=fifo|off|auto` overrides the detection (#76).
- b13db35: Detect stalled tickets and end orphaned ones. The daemon samples every running ticket's process-tree CPU time (Linux `/proc`, macOS `ps`) and flags a run `stalled` once it is past `CARGO_HAULER_STALL_ESTIMATE_FACTOR` (3) times its estimate with no CPU and no output for `CARGO_HAULER_STALL_IDLE_MS` (10 min). `hauler status` / `hauler_status`, the dashboard, and `hauler await` heartbeats show `stalled` with the idle duration; `hauler result` / `hauler_result` answer `ticket looks stalled (no CPU for Nm) — hauler kill cc-N`. A stalled ticket whose submitting connection has disconnected is killed automatically through the `hauler kill` path with the error `stalled: no CPU for Nm after owner disconnected; killed automatically`; `CARGO_HAULER_STALL_AUTO_KILL=0` only flags. Status records gain optional `stall` and `orphaned` fields. (#46)
- cfb6967: Keep every ticket's whole output on disk and make it readable after the fact. The daemon writes a leader run's combined stdout+stderr, as emitted (rendered diagnostics for demultiplexed runs, ANSI as captured), to `<state dir>/tickets/<ticket>.log`, bounded by the new `CARGO_HAULER_TICKET_LOG_MAX_BYTES` (default 64 MiB, then one truncation line; `0` disables). The ledger gains `output_path`, exposed as `outputPath` on every request record (attached followers carry their leader's path); the startup retention pass removes the logs of pruned rows and any log without a row. `hauler result <ticket>` now shows `Full output: <path> (size)` and `--json` carries `request.outputPath`; `hauler result <ticket> --full` and `hauler_result { ticket, full: true }` render the whole log as the document body (the last ~768 KiB when it does not fit, with the path for the rest). When a synchronous command is auto-backgrounded and the caller's stdout is not a terminal, the exit-75 notice adds that the redirect receives no output and to read it with `hauler result cc-N --full`. (#68)

## 0.4.4

### Patch Changes

- 92e168c: Bump `agent-bundle` and `@agent-bundle/runtime` to the pkg.pr.new preview at `42539ff5f`. With agent-bundle#461 a pass-through `tool/before` result no longer auto-approves, so the hook now answers `allow` only when every command in the input was rewritten onto (or already runs through) the hauler exec path, `continue` + `updatedInput` when a rewritten cargo command shares the input with something the daemon does not govern (`cd … && cargo build`, `cargo test | tail`), and plain `continue` (no decision) for every other tool call; it never returns `ask`. Accept the `confirmed` lineage resolution (agent-bundle#486) in ticket attribution.

## 0.4.3

### Patch Changes

- a2c39f3: Bump `agent-bundle` and `@agent-bundle/runtime` to the pkg.pr.new preview at `5775351fb`, which drops the Claude `plugin.json` `hooks` pointer so Claude Code no longer rejects the plugin with "Duplicate hooks file"
- ccd6a50: Start the auto-spawned daemon with a curated environment (`PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `TMPDIR`, `LANG`/`LC_*`, `XDG_*`, `CARGO_HOME`, `RUSTUP_HOME`, `SSL_CERT_*`, `*_proxy`, `CARGO_HAULER_*`) and the state directory as its cwd, so the first client's `RUSTFLAGS`, `CARGO_TARGET_DIR`, `RUSTC_WRAPPER`, or fd-based `MAKEFLAGS` no longer become the base of every other session's builds. `hauler exec` now relays SIGINT/SIGTERM: a brokered ticket is killed before the client exits `130`/`143`, a direct run's cargo process group is terminated instead of orphaned. A ticket that ends other than `done` prints `ticket cc-N <status>[: reason]` with `128 + signal` for signaled runs; a connection lost after the ack names the ticket (`hauler result cc-N`); a direct run prints its spawn error. The ack carries `waitEtaMs` and auto-background decides on queue wait plus runtime, shown as `wait ~Ns, run ~Ns`. A daemon that never accepted within 60 s goes straight to a direct run instead of a start attempt and a second cycle. `--cwd` is resolved against the caller. `CARGO_HAULER_CARGO_BIN` is read from the daemon's own environment. The PATH shim falls back to the real cargo when its hauler entry is gone and `install-shim` says to re-run `--force` after upgrades. Descriptor-based `MAKEFLAGS`/`MFLAGS`/`CARGO_MAKEFLAGS` jobservers are not transported. Heartbeats count from `started`; a failed or unconfirmed detach is reported; `hauler request --session` no longer holds the stop hook (matching `exec --bg`); `await`/`result`/`kill` fail fast on a daemon `error` reply (#55)
- ab91d88: Harden the daemon's socket and singleton-lock lifecycle. The daemon now listens on `daemon.sock.<pid>` and atomically renames it over `daemon.sock`, so a daemon that lost socket ownership no longer deletes its replacement's socket on the way out (previously both daemons died and their in-flight tickets were reaped as orphaned). `hauler daemon run` acquires the singleton lock before opening the ledger, running migrations, or draining the passthrough spool, so a losing instance touches neither; it re-checks a held lock about once a second for up to ~20 s instead of giving up on the first look, treats a lock written before the current boot as stale whatever its recorded pid, treats a pid it cannot signal (`EPERM`) as unknown rather than alive, and reclaims a stale lock atomically so two cold starters can no longer both start. A second Ctrl-C during shutdown is now swallowed instead of skipping finalizers and leaving the lock and socket behind (#50)
- d09b2fb: Harden the `tool/before` shell rewrite and its companions. The rewrite now leaves a command untouched when the pinned `bashjsast` parser cannot round-trip it — background `&`, the `time` keyword, `|&`, `coproc`, and a heredoc feeding a pipeline previously came back as a blocking, un-timed, or syntactically broken command. It no longer passes `--cwd`, so `cd crates/foo && cargo build` builds in `crates/foo`; it skips `command -v/-V cargo`, `type cargo`, and `which cargo`; wraps the unbrokered half of `hauler exec -- cargo build && cargo test`, `while ! cargo build`, and `rustup run <toolchain> -- cargo`. The `cargo clean` guard distinguishes a busy daemon (probe timeout → brokered so the lane serializes the clean) from an absent one (raw run). `tool/after` announces only background or detached tickets, never a foreground run the agent just watched. The stop route clamps `CARGO_HAULER_STOP_WAIT_MS` to the 2 h await ceiling, and `hook-state.json` is written atomically with per-session deny-counter pruning. (#56)
- df912ae: Honour `hauler kill` for a job parked at the admission gate or on the permit semaphore (it settles `killed` at once instead of blocking its lane until a permit frees), never fold a kill-requested queued job into a batch, clamp the queue ETA so an overrunning lane head no longer cancels queued work and count a head parked at the gate, and finish every settlement step (waiters, lane release, follower exits) even when a ledger write fails. Late attachers receive each replayed chunk exactly once, a follower whose leader exits during registration stays settled (attach/running ledger writes never reopen a terminal row), an early follower release can no longer surface as a `pump failed` cargo termination, and identity attach requires callers to agree on `mergeStderr`. When the shared jobserver FIFO is armed the daemon no longer sets `CARGO_BUILD_JOBS`; `CARGO_HAULER_JOBS_GRANT` applies only while the FIFO is unavailable. (#51, #52, #54)
- 3f70b60: Keep the daemon responsive and its storage bounded. Kache priors are refreshed without blocking the event loop: the `events.jsonl` tail is read asynchronously from a persisted byte offset and parsed in yielding slices, and the `index.db` aggregate is recomputed only when the file changes on disk. The ledger gains a startup retention pass — finished requests older than `CARGO_HAULER_LEDGER_RETENTION_DAYS` (default `30`) or beyond `CARGO_HAULER_LEDGER_MAX_ROWS` (default `50000`) are deleted with their transitions; `0` disables either limit — the attachment-savings backfill runs once per database (`PRAGMA user_version`) through the rowid index instead of on every open, and request/transition writes commit atomically. NDJSON client lines are capped at 16 MiB: an oversize line gets a `bad-message` error and the connection is closed. Numeric `CARGO_HAULER_*` overrides that do not parse or fall outside their range now log a warning and keep the default instead of silently disabling the arm; `0` or `off` still disables where documented, `CARGO_HAULER_MEM_PRESSURE_SOFT` must stay below `CARGO_HAULER_MEM_PRESSURE_HARD`, and `CARGO_HAULER_BATCH=false|off|no` disables batching like `0` (#57).
- dd778ab: Fold `cargo test` / `cargo nextest run` requests only when their test selection is identical — same `--test` targets, name filters, arguments after `--`, and nextest filterset — so a composite runs exactly what each participant asked for over the union of their packages (`cargo test -p a` + `cargo test -p b` → `cargo test -p a -p b --no-fail-fast`), never a foreign target or filter. When a composite fails, a folded participant inherits the failure only if it named every package the composite ran; otherwise it is requeued and runs alone instead of reporting another package's failure as its own. Unmodeled post-subcommand options that take a value (`-j`/`--jobs`, `--color`, `--message-format`, `-Z`, `--config`, and nextest's `--retries`, `--test-threads`, `-P`, …) now consume that value instead of recording it as a test-name filter (#53).

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
