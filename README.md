<p align="center"><img src="docs/media/logo-transparent.png" width="240" alt="cargo-hauler logo"></p>

# cargo-hauler

Cargo request broker for concurrent Rust development tools, shipped as an
[agent-bundle](https://github.com/ScriptedAlchemy/agent-bundle) application
for Claude Code, Codex, and Cursor.

cargo-hauler accepts Cargo requests from agent sessions, scripts, and
terminals. A daemon groups compatible work, limits process concurrency, and
returns each result to the callers that requested it. The plugin in this
repository is the app that agents talk to: six MCP tools, a routed CLI, four
hook routes, two skills, and a browser dashboard, all rendered from one
component library through one shared layout.

![cargo-hauler dashboard with active and queued requests](docs/media/dashboard-overview.png)

## Tour

Everything an agent sees is a React Server Component rendered by the
agent-bundle runtime into an Agent Document, then lowered to MCP content, CLI
Markdown, `--json`, or a host hook envelope. There is no hand-written server,
argv parser, or string-concatenated Markdown; the `src/` tree is the app.

```text
src/
  layout.tsx                    the hauler shell around every rendered route
  providers/hauler-daemon.ts    request-scoped daemon connection + health probe
  components/                   typed components over pure view-models
  mcp/hauler/tools/*.tsx        hauler_status, _log, _last, _await, _result, _request
  mcp/hauler/apps/dashboard.tsx the MCP App (ui://cargo-hauler/dashboard.html)
  cli/*.tsx, cli/daemon.ts      the routed `cargo-hauler` CLI, same components
  events/{session/start,tool/before,tool/after,stop}.tsx   hook routes
  skills/cargo-hauler/SKILL.md, skills/hauler-dashboard/SKILL.tsx
  scripts/hauler.ts             the `hauler` process entry hooks rewrite cargo to
  daemon/, client/, hooks/, shim/, lib/   the broker and its libraries
```

### The shell (`src/layout.tsx`)

Every rendered route — MCP tool, CLI command, rendered script — composes
through one layout, the way a page framework's `layout.tsx` wraps every page:

- **Header:** `<DaemonBadge>` prints what the request-start probe proved:
  `cargo-hauler · daemon running (pid 4021) · 2/5 permits +1 riding, 1 queued
  · 2 lanes busy · up since 3h ago`, or `daemon stopped · no socket; it starts
  on demand…`, or `daemon unresponsive · did not accept a connection within
  750ms (machine saturated)…`.
- **Body:** the route's own document, unchanged. The route keeps its
  `<Agent.Result value>`; the runtime merges it into the shell so
  `structuredContent` and `--json` are exactly what the route declared.
- **Footer:** `<LineageFooter>` names the conversation the request belongs to
  (`Requested by conversation conv-7f (depth 1 under conv-2a; registry)`),
  read synchronously with `useAgent()`, and stays silent when the host cannot
  place the request rather than guessing.
- **`_meta.hauler`** on every MCP result: `route`, `surface`, `server`,
  `version`, `daemon: { state, pid? }`, `lineage: { conversation, root, depth } | null`.

Event routes are host protocol responses and are never wrapped.

### The daemon provider (`src/providers/hauler-daemon.ts`)

One request-context provider mounts `providers.haulerDaemon` for every tool,
command, event, and script: the resolved `config` (state dir, socket, ledger)
and a `health` value from one bounded `status` probe:

| `health.state` | meaning |
| --- | --- |
| `running` | `pid`, `startedAtMs`, `latencyMs`, `running` (permit holders), `riding` (attached), `queued`, `busyLanes`, `maxConcurrent` |
| `stopped` | `socket-missing` (starts on demand) or `connection-refused` (stale socket) |
| `unresponsive` | `accept-timeout` (never accepted), `answer-timeout` (accepted, no `status-result`), or `connection-closed` within the probe budget (750 ms for the accept and for the answer); ledger reads still work |
| `unreachable` | `open-failed` with the errno (`EACCES`, `EMFILE`, …): the socket is present but could not be opened, which is not evidence the daemon is down |
| `unprobed` | `event-surface`: hooks run on every shell command and skip the probe by design |

The provider fails closed on nothing it can observe and fabricates nothing.
Routes read it through `requestDaemon(context)` / `requestDaemonConfig(context)`;
tests inject a fixture through the harness `context.providers` seam.

### Components (`src/components/`)

Components render view-models and nothing else. The models are pure functions
in `view-models.ts`, so the MCP document, the CLI Markdown, and a test
assertion share one derivation.

| Component | Renders |
| --- | --- |
| `<TicketCard>` | one ticket: headline, attribution, lane, queue position, attach mode, timings, exit, then `<BuildDiagnostics>` and `<LogTail>` |
| `<TicketList>` | the in-flight and recent tables of status, and the whole of log |
| `<LaneBoard>` | busy lanes with their leader ticket, its command, and how long it has run |
| `<AdmissionState>` | permits in use, load, memory clamp, sharing savings; calls out a paused admission gate |
| `<KacheStats>` | kache coverage and freshness, slowest crates by profile, or an honest "not detected" |
| `<LogTail>` | the captured output tail, labelled live while the run is in progress |
| `<BuildDiagnostics>` | an index of cargo `error[E…]`/`warning:` blocks (level / code / message / location) followed by every captured block verbatim |
| `<DashboardLink>` | where the MCP App lives and how to open it elsewhere |
| `<TicketGuidance>` | what to do next, one component per ticket status |
| `<DaemonBadge>`, `<LineageFooter>` | the shell header and footer |
| `<EmptyState>`, `<UnavailableState>`, `<ErrorState>` | the three non-happy shapes every document may take |

`documents.tsx` composes them into one document per hauler result
(`StatusDocument`, `LogDocument`, `LastDocument`, `ResultDocument`,
`AwaitDocument`, `RequestDocument`); the MCP tool and the CLI command for the
same operation render the same document with different command spellings
(`surface.ts`).

### Streaming (`src/components/streaming.tsx`)

`hauler_await` and `hauler_log` are progressive documents. Each is a
valueless `Agent.Result` container around one `Suspense` boundary:

- `<AwaitStream>`: the fallback is the ticket **as it is now** — its live
  output tail and a progress node — rendered before the daemon-side wait
  blocks; the settled child is the ordinary `AwaitDocument`. MCP hosts receive
  the fallback's progress as notifications and the settled value as
  `structuredContent`; the routed CLI updates the terminal in place. Heartbeats
  (queue position, elapsed time, cost estimate) still flow through
  `context.progress`.
- `<LogStream>`: a "reading the ledger" progress frame, then the listing.

### Attribution and lineage

`hauler_request` attributes tickets from the request context: an explicit
`host`/`session` wins; otherwise the negotiated host and native session are
used; and when the transport publishes no session id (bare stdio MCP), the
conversation from `request.lineage` becomes the session of record. That is
what makes parallel agents' builds attributable in the ledger, the dashboard,
and `hauler status --session <conversation>` (the `hauler_status` tool takes
the same filter as its `session` field). Results carry
`attribution: { host, session, lineage }`.

### Routes

| Route | Surface | Document |
| --- | --- | --- |
| `tool:hauler/hauler_status` · `cli:status` | queue, lanes, admission, kache, filters | `StatusDocument`; the tool advertises the dashboard App |
| `tool:hauler/hauler_log` · `cli:log` | recent requests | `LogStream` → `LogDocument` |
| `tool:hauler/hauler_last` · `cli:last` | most recent request | `LastDocument` |
| `tool:hauler/hauler_await` · `cli:await` | long-poll a ticket (≤ 2 h) | `AwaitStream` → `AwaitDocument` |
| `tool:hauler/hauler_result` · `cli:result` | one ticket, live tail while running | `ResultDocument` |
| `tool:hauler/hauler_kill` · `cli:kill` | stop a queued or running ticket | `KillDocument` |
| `tool:hauler/hauler_request` · `cli:request` | submit a background request | `RequestDocument` |
| `cli:daemon` | `run` / `start` / `stop` / `status` | plain JSON, exit code from the result |
| `event:session/start` | new session | daemon state and the no-kill rule as context |
| `event:tool/before` | shell tool about to run | rewrites `cargo …` to `hauler exec --session … --host … -- cargo …`; denies `cargo clean` during in-flight builds |
| `event:tool/after` | shell tool finished | injects finished-ticket results once per session |
| `event:stop` | agent stopping | holds the stop while a foreground ticket is pending (bounded, re-deniable) |

### Skills

`skills/cargo-hauler/SKILL.md` is the operating rule set (do not kill
in-flight cargo, scope with `-p`, await tickets, fail open when the daemon is
unreachable). `skills/hauler-dashboard/SKILL.tsx` is a rendered skill: the
build computes its Markdown from the tool and CLI spellings and the App
resource URI it describes, so the document cannot drift from the surface.

### Dashboard

`src/mcp/hauler/apps/dashboard.tsx` is the MCP App at
`ui://cargo-hauler/dashboard.html`, attached to `hauler_status` on hosts that
render MCP Apps. It shows contention and admission, in-flight and queued
work, metrics windows, optional kache data, lanes, and history, with a live
output drawer per ticket.

![cargo-hauler metrics for one-hour, 24-hour, and all-time windows](docs/media/dashboard-metrics.png)

## Install

Requirements: Node 22.19 or newer, Cargo, and Linux or macOS (Windows is
experimental: named-pipe transport, no PATH shim).

```sh
pnpm install
pnpm run build      # artifact/{claude,codex,cursor,portable} + dist/bin
```

Each host pack under `artifact/<host>` is independently installable through
the framework's installer. The packs are framework-owned; this project ships
no installer of its own.

```sh
# Claude Code (local marketplace + plugin install)
pnpm exec agent-bundle install claude --from artifact/claude --scope user

# Codex
pnpm exec agent-bundle install codex --from artifact/codex

# Cursor: safe-copy into ~/.cursor/plugins/local/cargo-hauler (default), or
# stage a local marketplace repository for Customize → Add Plugins from Local Repository
pnpm exec agent-bundle install cursor --from artifact/cursor --mode local
pnpm exec agent-bundle install cursor --from artifact/cursor --mode marketplace
```

Add `--replace` to any of them after a same-version rebuild. From an `npm
pack`ed tarball the same operations are
`npx cargo-hauler-install install <host> [--scope …] [--mode …] [--json]`
(`dist/bin/cargo-hauler-install.js`, generated by the build and gated by
`agent-bundle prepack`). `agent-bundle doctor --host <host>` reports the
installed copy versus the artifact (`current`, `stale`, `version-mismatch`,
`foreign`, `not-installed`) and, for Cursor, whether the manifest hooks are
registered. Each pack's `INSTALL.md` carries the same commands with the exact
compiled names. Restart or reload the host after installing so new sessions
load the hooks. Per-host notes, hook timeouts, and the optional PATH shim are
in [docs/install.md](docs/install.md).

The first brokered request makes one daemon-start attempt. Hooks cover Cargo
commands submitted through supported agent shells; the optional PATH shim
(`node dist/bin/hauler.js install-shim`) also covers Cargo invoked by scripts
and terminals.

## Interfaces

`hauler` is the process entry (`src/scripts/hauler.ts`): `exec`, `daemon`, and
`install-shim`, forwarding every other command to the routed `cargo-hauler`
executable beside it (`dist/bin/cargo-hauler.js` in the package,
`bin/cargo-hauler.mjs` inside every host pack). Routed commands accept
`--json` for the canonical value and `--ndjson` for the render-event stream.

| Command | Behavior |
| --- | --- |
| `hauler exec [--session ID] [--host HOST] [--cwd DIR] [--bg] -- <cargo …>` | Submit Cargo through the daemon and stream output; hooks rewrite commands to this form. A relative `--cwd` is resolved against the caller's directory. Exits with cargo's code; `130`/`143` after a SIGINT/SIGTERM (the ticket is killed first); `75` when auto-backgrounded. |
| `hauler status [--limit N] [--cwd DIR] [--session ID] [--lane KEY] [--ticket ID …] [--status S …] [--command-contains TEXT]` | Queue, active runs, lanes, admission, kache, optionally filtered. |
| `hauler log [--limit N]` | Recent requests from the ledger. |
| `hauler last` | The most recent request. |
| `hauler await <ticket> [--max-wait-ms N]` | Long-poll until the ticket finishes or the wait expires (default 30 s, ceiling 55 s per call — the rendered-route budget; call again to keep waiting). |
| `hauler result <ticket>` | A stored ticket; running tickets include a live output tail. |
| `hauler kill <ticket>` | Stop a ticket: drop it from the queue or SIGTERM (then SIGKILL) its cargo process group, freeing the lane. Riders return to their lane or fail with it. |
| `hauler request [--session ID] [--host HOST] [--cwd DIR] -- <cargo …>` | Submit a background request and return its ticket. |
| `hauler daemon <run\|start\|stop\|status>` | Manage the daemon lifecycle. |
| `hauler install-shim [--dir DIR] [--real-cargo PATH] [--force]` | Install the optional PATH shim. |

The `hauler` MCP server projects the same operations as `hauler_status`,
`hauler_log`, `hauler_last`, `hauler_await`, `hauler_result`, `hauler_kill`,
and `hauler_request`, with the same filters as the CLI.

## Testing

```sh
pnpm run check   # validate + build + typecheck + Effect diagnostics + rstest + route tests
```

`tests/route-unit/` renders the app through the framework compiler with no
artifact build, at the harness proof levels:

| Level | Suite | What it proves |
| --- | --- | --- |
| route-unit | `routes`, `layout`, `streaming`, `events` | documents, shell metadata, Suspense fallbacks and settled values, lineage attribution, event decisions |
| cli-dispatch | `cli-dispatch`, `layout` | argv through the routed CLI shell; Markdown wrapped by the shell, `--json` bare |
| script-dispatch | `script-dispatch` | the `hauler` entry through its `main` envelope as its own process |
| mcp-in-memory | `mcp-surface`, `layout` | tool names, `outputSchema`, the dashboard resource link, `_meta.hauler`, and a live fixture broker over the in-memory transport |
| packed-stdio | `packed-contract` | the built `artifact/cursor` server as a real process against a live broker, every tool through the wire-contract matrix |
| workbench-surface | `tests/workbench-surface.test.ts` | what `agent-bundle dev` would show: catalog, provider, lifecycles per host, counts |

Daemon-backed cases run a real broker in-process with a fake `cargo`
(`tests/harness.ts`) and reach it either through the `haulerDaemon` provider
seam or through `CARGO_HAULER_STATE_DIR`.

## How the broker works

Requests enter through the `hauler` CLI, `tool/before` hooks that rewrite
shell commands, an optional PATH shim, or the `hauler_request` MCP tool. The
daemon normalizes the Cargo command into an intent, records a ticket in the
SQLite ledger, and assigns the request to a lane.

The hook parses the shell command and rewrites each Cargo invocation to
`hauler exec --session … --host … -- cargo …`. It recognizes `cargo` behind an
absolute path (`~/.cargo/bin/cargo`), and behind the wrappers agents actually
use: `env -u VAR X=y cargo …`, `timeout 600 cargo …`,
`rustup run <toolchain> cargo …`, `stdbuf`, `nice`, `ionice`, `nohup`,
`time`, `strace`, `sudo`, `xargs`, `command`, `exec`, and `builtin`. Other
`rustup` subcommands and already-wrapped commands are left alone.

A lane is keyed by workspace root and resolved target directory. It runs one
job at a time. Different lanes may run concurrently after acquiring one of the
global admission permits. `CARGO_HAULER_MAX_CONCURRENT` controls the
machine-wide permit count and defaults to five Cargo processes. Attached
requests (riders) do not hold permits; the admission meter counts permit
holders and reports riders separately.

Within a lane, the daemon can reduce work in three ways:

1. **Identity attachment:** a byte-identical request attaches to an in-flight
   run.
2. **Coverage attachment:** a narrower `check` attaches to a compatible
   `build` or `check` that covers its package and target scope.
3. **Batch folding:** compatible queued compile or test requests are combined
   into one invocation.

Each admitted leader starts one Cargo process. Identity, coverage, and folded
batch requests share that process and receive its streamed output. A failed
stronger compile does not satisfy a coverage or compile-batch attachment; the
attached request returns to its lane unless its required compilation units were
already observed as successful. Folded tests share the composite process,
output, and exit code.

Brokered output keeps cargo's stdout and stderr as separate channels. When the
caller's own stdout and stderr are the same open file (`cargo run 2>&1`, a
shared terminal, `| tee`), the client asks the daemon to run the child with
stderr on the stdout pipe, so the program's write order across the two streams
is preserved exactly as direct cargo would have. Demultiplexed `build`,
`check`, and `clippy` runs keep separate channels because the JSON stream owns
stdout.

![cargo-hauler request normalization, lane-local serialization, scheduling, admission, and concurrent Cargo processes](docs/media/how-it-works.png)

The scheduler estimates run cost from per-intent EWMA history. It can also use
per-crate timing data from kache. Lower-cost work, requests with more attached
callers, dependency-unblocking work, and recently edited packages receive a
lower scheduling score. Waiting time lowers the score further so broad work
eventually runs.

Admission is separate from lane scheduling. It observes one-minute load per
core and, on Linux, CPU PSI `some avg10`, then applies the configured thresholds
and the global permit cap. Load and CPU pressure never defer below
`CARGO_HAULER_LOAD_MIN` running processes, so a saturated machine still makes
progress. Memory pressure is a separate admission input: on Linux the daemon
reads memory PSI `full avg10` and `MemAvailable`; on macOS it reads the kernel
VM pressure level. Soft pressure defers admission like load does, respecting
the same floor; hard pressure defers admission regardless of the floor, and
the `<AdmissionState>` component calls it out as a paused gate. While Linux
`MemAvailable` is below 16 GiB, heavy leaders (`--release`/`-r`, non-dev
`--profile`, `cargo bench`, `--workspace`/`--all`) are additionally capped to
one at a time; other leaders, riders, and machines without the signal are
unaffected, and a held ticket says why (`waiting: …`) in its card and in
heartbeats. Non-compiling cargo subcommands (`fmt`, `update`, `fetch`, `add`,
`remove`, `generate-lockfile`, `vendor`, `new`, `init`, `info`, `uninstall`)
run locally instead of queueing for a permit.

The per-run `CARGO_BUILD_JOBS` grant defaults to the available cores divided
across the configured permit count, with a floor of four jobs. Separately, the
daemon arms one GNU make jobserver FIFO with `cores - 1` tokens when it
acquires the singleton lock and passes it to every Cargo it spawns through
`MAKEFLAGS`, so concurrent lanes share one global rustc parallelism budget.

| Capability | Behavior |
| --- | --- |
| Work sharing | Identical requests attach, covered checks attach, and compatible queued compile or test requests fold. |
| Lane isolation | A workspace-root and target-directory pair is serialized independently from other lanes. |
| Admission | Per-core load, Linux CPU PSI, Linux memory PSI and `MemAvailable`, macOS VM pressure, configured thresholds, and the global permit cap control new starts. |
| Parallelism | A per-run `CARGO_BUILD_JOBS` grant plus one daemon-owned jobserver FIFO shared by every spawned Cargo. |
| Scheduling | EWMA estimates, optional kache priors, fan-out, dependency topology, recent edits, and request age determine lane order. |
| Persistence | Tickets, output tails, timings, outcomes, and savings are stored in SQLite. |
| Caller output and status | Output streams to attached callers; late callers receive buffered replay. After 30 seconds without output, the client emits a progress heartbeat every 15 seconds with lane queue position, the lane-head ticket, and an aggregate wait ETA. |
| Wait escalation | A queued request waiting longer than the larger of twice its own estimate and ten minutes is flagged as delayed; running jobs silent for more than five minutes show a quiet-duration hint. Nothing is killed automatically. |
| Daemon status | `running`, `stopped`, or `unresponsive`: a socket that exists but does not answer within its budget is reported as unresponsive, never as stopped. |

### Tickets and long-running requests

Every request has a durable ticket (`cc-<n>`). Its status, exit code, output
tail, estimate, and timestamps are stored in SQLite and can be read from later
sessions. `hauler exec --bg -- cargo …` and `hauler_request` return the ticket
immediately. A synchronous request also switches to background mode when a
*measured* estimate — EWMA history or kache priors, never the cold-start
default — exceeds the host's shell-tool cap (nine minutes for Claude, ten for
Codex, fourteen for Cursor; the PATH shim uses `CARGO_HAULER_HOST` when it is
exported, otherwise the Claude cap). The estimate that is compared is the
whole wait: the work queued ahead in the lane plus the job's own runtime,
which the queued line reports as `wait ~Ns, run ~Ns`. That conversion exits
`75` (`EX_TEMPFAIL`) with the ticket on stderr, so `cargo build && …` chains
and scripts cannot mistake "submitted" for "built"; explicit `--bg` keeps exit
`0`. Failed runs feed the estimate history too, so a broken build is not
re-estimated cold on every retry.

A foreground `hauler exec` that receives SIGINT or SIGTERM (Ctrl-C, or a
`timeout N …` wrapper) asks the daemon to kill its ticket, waits for the
answer, and exits `130` or `143`; in a direct run it terminates the cargo
process group the same way. A ticket that ends other than `done` is reported
on stderr as `ticket cc-N <status>[ (signal)][: reason]`, and its exit code is
cargo's, `128 + signal` for a signaled run, or `1` when the daemon could not
start cargo at all. If the connection drops after the ticket was accepted, the
client prints `connection to daemon lost; ticket cc-N continues — hauler
result cc-N` and exits `1`; the daemon finishes the ticket on its own.

The `tool/after` route checks session tickets and, on the first tool call
after a ticket finishes, adds its result to the agent context. For foreground
tickets, the `stop` route waits for the lower of the remaining estimate and
`CARGO_HAULER_STOP_WAIT_MS`; if the ticket finishes it denies the stop and
returns the result, otherwise it denies with status and ETA. `stopHookActive`
and an eight-denial cap per ticket prevent a repeated stop loop; background
tickets never hold a stop. Codex 0.147.0 stop-hold behaviour is verified in
[docs/codex-hooks.md](docs/codex-hooks.md).

### PATH shim

At installation the shim embeds absolute paths for both the `hauler` CLI and
the Cargo binary (the `~/.cargo/bin/cargo` link, not its rustup proxy target,
because rustup dispatches on `argv[0]`). It tags requests with `--host shim`.
When the daemon starts Cargo it sets `CARGO_HAULER_INSIDE=1`, and the shim then
invokes the embedded Cargo directly, so the daemon's own Cargo never returns
through the broker. The shim is POSIX-only; its directory must appear before
rustup's Cargo directory on `PATH`; replacing an existing destination requires
`--force`. The embedded `hauler` entry lives in a versioned plugin directory:
when that file no longer exists (an upgrade replaced the directory), the shim
runs the embedded Cargo directly instead of failing, and `install-shim` says
so — re-run `hauler install-shim --force` after such an upgrade to route
scripted Cargo through the broker again.

### Caller environment

`hauler exec` (and therefore the shim and the hook rewrites) forwards the
caller's whole environment to the daemon, except the `CARGO_HAULER_*` and
legacy `CARGO_CONDUCTOR_*` settings, which configure the broker itself. The
daemon lays the forwarded variables over its own environment when it spawns
Cargo, so `FOO=bar cargo build` reaches `build.rs`, `env!()`, `cargo run`, and
`cargo test` processes exactly as a direct invocation would. Request identity
for coalescing is digested from the build-relevant subset only (`CARGO_*`,
`RUST*`, `CC`/`CXX`/`AR`/`CFLAGS`/`CXXFLAGS`/`LDFLAGS` with target-suffixed
forms, and `PKG_CONFIG_PATH`); pass knobs a `build.rs` reads through
`--config 'env.FOO="bar"'` when they must also split identity. One value is
filtered rather than forwarded: a `MAKEFLAGS`, `MFLAGS`, or `CARGO_MAKEFLAGS`
carrying a descriptor-based jobserver (`--jobserver-auth=R,W`,
`--jobserver-fds=R,W`) names file descriptors that exist only in the caller,
so it is dropped and the daemon's shared FIFO jobserver applies; a
`fifo:PATH` jobserver travels as-is.
`hauler request` and `hauler_request` submit without a caller environment;
their Cargo processes run with the daemon's environment.

The daemon's own environment is deliberately small. When a client starts it,
the daemon receives only `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `TMPDIR`,
`LANG` and `LC_*`, `XDG_*`, `CARGO_HOME`, `RUSTUP_HOME`, `SSL_CERT_*`, the
`*_proxy` variables, and every `CARGO_HAULER_*` setting, with the state
directory as its working directory. The starting shell's `RUSTFLAGS`,
`CARGO_TARGET_DIR`, `RUSTC_WRAPPER`, `CARGO_BUILD_*`, `MAKEFLAGS`, `CC`, and
similar build knobs are not inherited, so they cannot become the silent base of
every other session's builds.

### Kache integration

When [kache](https://github.com/ScriptedAlchemy/kache) is available,
cargo-hauler reads its machine-wide index for per-crate compile-time priors and
reports the slowest crates by profile (`<KacheStats>`). Without that index,
estimates come from the daemon's EWMA history. A missing or incompatible index
is reported as unavailable and never rejects a request.

![cargo-hauler dashboard kache timing panel](docs/media/dashboard-kache.png)

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `CARGO_HAULER_STATE_DIR` | Per-user cache directory | Unix socket or Windows named pipe source, SQLite ledger, daemon log, pid lock, `hook-state.json`, and `hook-events.jsonl`. No legacy alias. |
| `CARGO_HAULER_CARGO_BIN` | `$CARGO_HOME/bin/cargo` | Cargo binary for daemon-started work; bare `cargo` is the last fallback. Never resolved through `PATH`. Read from the daemon's own environment (export it where the daemon starts, or before `hauler daemon start`); clients do not forward it. |
| `CARGO_HAULER_MAX_CONCURRENT` | `5` | Global admission permits for Cargo processes across all lanes. |
| `CARGO_HAULER_JOBS_GRANT` | `max(4, cores / max concurrent)` | `CARGO_BUILD_JOBS` added to each Cargo process; `0` disables injection. |
| `CARGO_HAULER_LOAD_THRESHOLD` | Disabled | Per-core one-minute load threshold for deferring new admissions. |
| `CARGO_HAULER_LOAD_MIN` | `2` | Active Cargo processes below which load, CPU PSI, and soft memory pressure do not defer admission. |
| `CARGO_HAULER_CPU_PRESSURE_THRESHOLD` | `75` | Linux CPU PSI `some avg10` percentage for deferring new admissions; `0` disables. |
| `CARGO_HAULER_MEM_PRESSURE_SOFT` | `10` (Linux) | Memory PSI `full avg10` percentage for soft deferral; `0` disables. |
| `CARGO_HAULER_MEM_PRESSURE_HARD` | `20` (Linux) | Memory PSI `full avg10` percentage for hard deferral, confirmed by `full avg60` at half the value; `0` disables. |
| `CARGO_HAULER_MEM_AVAILABLE_MIN_GB` | `8` (Linux) | `MemAvailable` floor in GiB for hard deferral; `0` disables. |
| `CARGO_HAULER_MEM_PRESSURE_LEVEL` | `2` (macOS) | Kernel VM pressure level that starts soft deferral (`2` warn, `4` critical). |
| `CARGO_HAULER_HEAVY_MEM_AVAILABLE_GB` | `16` (Linux) | `MemAvailable` in GiB below which concurrent heavy leaders (release/perf/bench profiles, workspace-wide runs) are capped; `0` or `off` disables the cap. |
| `CARGO_HAULER_HEAVY_MAX_CONCURRENT` | `1` | Heavy leaders admitted at once while the cap is active. |
| `CARGO_HAULER_REPLAY_BUFFER_BYTES` | `4194304` | Leader output retained in memory for late-attacher replay. |
| `CARGO_HAULER_KACHE_INDEX` | kache's configured store | kache index for per-crate timing priors; an empty string disables it. |
| `CARGO_HAULER_BATCH` | Enabled | `0` disables the batch composer. |
| `CARGO_HAULER_BATCH_WINDOW_MS` | `150` | Delay applied to a batchable lane head so nearby requests can fold; `0` disables. |
| `CARGO_HAULER_KILL_GRACE_MS` | `8000` | Time between SIGTERM and SIGKILL when the daemon stops a Cargo process. |
| `CARGO_HAULER_STOP_WAIT_MS` | `30000` | Maximum wait for one stop-hook invocation. |
| `CARGO_HAULER_LOG_LEVEL` | `Info` | Daemon log level. |
| `CARGO_HAULER_HOST`, `CARGO_HAULER_SESSION` | Unset | Default `--host` and `--session` attribution for `hauler exec`; the PATH shim also borrows `CARGO_HAULER_HOST`'s shell cap for auto-background. |

Each `CARGO_HAULER_*` tuning value takes precedence over its retained legacy
`CARGO_CONDUCTOR_*` alias; `CARGO_CONDUCTOR_STATE_DIR` is ignored and hand-run
commands warn when it is still exported (see
[docs/incidents/2026-09-01-state-identity-split-brain.md](docs/incidents/2026-09-01-state-identity-split-brain.md)).
The state directory defaults to `$XDG_CACHE_HOME/cargo-hauler`, otherwise
`~/.cache/cargo-hauler` on Linux, `~/Library/Caches/cargo-hauler` on macOS, and
`%LOCALAPPDATA%\cargo-hauler` on Windows. When `CARGO_HAULER_KACHE_INDEX` is
unset, the daemon reads kache's configured local store from
`$XDG_CONFIG_HOME/kache/config.toml` or `~/.config/kache/config.toml` and opens
`<local_store>/index.db` read-only.

## Runtime behavior and caveats

- Hook and client transport failures fail open: a hook passes the original
  command through, and a client that cannot reach the daemon makes one
  auto-start attempt and then invokes Cargo directly. A daemon that is alive
  but too loaded to accept within 2 seconds is not treated as absent: `exec`
  retries for up to 60 seconds, then runs Cargo directly without a start
  attempt or a second retry cycle.
- The plugin's own documents never fail open: `hauler_result` and
  `hauler_await` fail loudly when the daemon is unreachable instead of
  reporting a ticket as not found; `hauler_status`, `hauler_log`, and
  `hauler_last` read the ledger with the daemon marked `stopped` or
  `unresponsive`.
- Test sharing uses identity attachment or batch folding, never coverage.
  Folded `test` and `nextest` requests receive the composite output and exit
  code, so a failure may come from another package in the batch.
- Hook rewrites, policy denials such as `cargo clean` during an active build,
  and malformed requests are recorded (`hook-events.jsonl`; a failed ledger
  row).
- Linux and macOS are supported. Windows named-pipe transport is experimental;
  the POSIX PATH shim is unavailable and jobserver integration is disabled.
- Licensed under MIT.

## Development

```sh
pnpm run dev       # agent-bundle workbench with live rebuilds
pnpm run build     # artifact/{claude,codex,cursor,portable} and dist/bin
pnpm run inspect   # per-host component accounting
pnpm run doctor    # installed copies versus the artifact
pnpm run check     # the gate
```

To see the dashboard outside an MCP host, run `pnpm run dev` and open the
Workbench's MCP page: it binds a session to the generated `hauler` server and
previews the `ui://cargo-hauler/dashboard.html` App over that session, so the
data is the daemon's own. The repository ships no preview harness of its own.

agent-bundle does not yet have an npm release; this repository pins the
[pkg.pr.new](https://pkg.pr.new) preview of main commit
[`886b1921f`](https://github.com/ScriptedAlchemy/agent-bundle/commit/886b1921f64f7b857528acda32d94c4d0df9bba7)
for both `agent-bundle` and `@agent-bundle/runtime`. `inspect` reports the
`agent` component kind as unavailable on every host (agent-bundle G5
deferral); this plugin defines no agents. Two framework limitations observed
while building this app are tracked upstream: a rendered `SKILL.tsx` cannot
import `agent-bundle/meta`
([agent-bundle#440](https://github.com/ScriptedAlchemy/agent-bundle/issues/440)),
and `inspectWorkbenchSurface` fails on a project with a rendered skill when
run under the `react-server` condition of the route-unit pool
([agent-bundle#441](https://github.com/ScriptedAlchemy/agent-bundle/issues/441);
which is why `tests/workbench-surface.test.ts` lives in the plain pool).

`repos/effect` is a read-only subtree containing the Effect v4 source pinned to
`effect@4.0.0-rc.112`; see `AGENTS.md` before working with Effect code in this
repository.
