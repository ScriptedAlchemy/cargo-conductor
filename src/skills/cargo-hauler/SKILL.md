---
name: cargo-hauler
description: Orchestrate cargo through the hauler daemon — do not kill in-flight builds, scope with -p, and await tickets instead of re-running identical checks.
---
# cargo-hauler

Use this Skill whenever an agent is about to run `cargo` (check, test, build,
clippy, fmt, nextest) or is waiting on someone else's cargo.

## Rules

- Do not kill in-flight `cargo` processes by PID. Attach or await the existing
  ticket. If a ticket is genuinely stuck (a deadlocked test, an owner session
  that is gone), stop it through the broker — `hauler kill cc-N` or
  `hauler_kill` — so riders, the lane, and the ledger settle correctly.
- `stalled` on a running ticket (status, the dashboard, `hauler result`'s
  `ticket looks stalled (no CPU for Nm) — hauler kill cc-N`, or an await
  heartbeat) means the daemon measured it: the run is past three times its
  estimate, its whole process tree has used no CPU for ten minutes, and it
  printed nothing in that window — a deadlock, not a slow link. A long,
  silent build that is still burning CPU is never flagged, so trust the flag:
  run the `hauler kill cc-N` it names (the leader's ticket, even when yours
  is a rider), then resubmit. If the session that submitted a stalled ticket
  has already disconnected the daemon kills it itself and records
  `stalled: … killed automatically` as the error; resubmit in that case too.
  `estimateState: overrun` is the other case: the head is past three times
  its estimate but still producing output or CPU, so the queue ETA uses the
  intent's p90 remaining instead of zero. Background that ticket if you can
  wait; do not kill it as stalled.
- Scope work with `-p <crate>` instead of workspace-wide `--all-features` when
  a single crate answers the question.
- Prefer `hauler status`, `hauler last`, and the `hauler_status` MCP
  tool over `ps`/`pgrep` probes.
- Do not pipe status through `jq` just to find your work. Scope it directly:
  `hauler status --session <id>`, `--cwd <path>`, repeated
  `--ticket cc-N`, `--status running`, or `--command-contains <text>`.
  `hauler_status` accepts the equivalent structured fields. Status rows are
  summaries: a running row carries `outputPreview` (its last few lines),
  never the whole output tail. Read one ticket's tail with `hauler result
  cc-N` / `hauler_result`.
- Do not hand-roll `CARGO_TARGET_DIR` isolation or scratch clones to dodge
  locks. The daemon already serializes per (workspace, target dir); a private
  target dir only defeats attach/coverage sharing and multiplies compiles.
- Long builds: `hauler exec --bg -- cargo …` or `hauler_request`.
  Wait with `hauler await cc-N --max-wait-ms N` (one call waits up to the
  daemon's 2 h ceiling; call it again to keep waiting), or call `hauler_await`
  with the same `maxWaitMs`; do not hand-roll a tight `hauler_result` polling
  loop. A host with its own per-call deadline still bounds one call — Codex
  stops a tool call at `tool_timeout_sec` (60 s unless raised), so keep
  `maxWaitMs` under it there and call again. `hauler result cc-N` /
  `hauler_result` is for a point-in-time read and carries the whole output
  tail — the live in-memory tail while a run is still in progress. The
  dashboard drawer fetches that tail through `hauler_result` and refreshes
  it every three seconds.
- Lane order is by cost, not submission: a cheap queued test starts before an
  expensive queued build even if you submitted the build first. When a test
  (or `cargo run`) needs an artefact another ticket produces, submit the
  build, then the test with `--after cc-N` — `hauler exec --after cc-N --
  cargo test …`, `hauler request --after cc-N -- …`, or `after: ["cc-N"]`
  on `hauler_request`. The dependent stays queued until every prerequisite
  finishes, fails with `prerequisite cc-N failed` if one fails or is
  killed, and is rejected if the ticket is unknown. Read the acknowledgement:
  `queued behind cc-3281 (~13m)` means something ahead of you was reordered
  in front; `waiting for cc-3281` means the dependency is holding it.
- Triage a red ticket from its log, never by re-running it. The stored tail
  is bounded, but every run's whole output is on disk: `hauler result cc-N`
  prints `Full output: <path> (size)` (and `--json` carries
  `request.outputPath`); `hauler result cc-N --full` or `hauler_result` with
  `full: true` renders the whole log — the `failures:` list and each
  `---- <test> stdout ----` panic section of a `cargo test` run included. A
  log too large for one document shows its last part and the path; read
  the file directly for the rest. Re-running a 16-minute suite to see what
  failed doubles the cost and may not reproduce a flaky failure.
- If a shell command was auto-backgrounded while its stdout was redirected
  (`cargo test > out.log` exited 75), the file holds only the notice: the
  output is in the ticket log, `hauler result cc-N --full`.
- Folded test runs share one process. Queued `cargo test` requests with the
  same `--test` / `--lib` selection and harness flags (`--test-threads=N`,
  `--nocapture`, `--quiet`, `--exact` only) may fold across different
  packages, with different bare name filters, into one composite run over
  the union of both, with `--no-fail-fast` — `-- x::y --exact` and
  `-- z::w --exact` run as `-- x::y z::w --exact`, since libtest applies
  `--exact` to each filter. Exact and substring runs never mix; requests
  naming the same packages fold only on the same filters, and
  `cargo nextest run` requests only on an identical
  filterset. Every participant gets the composite's full output,
  so it may show tests another participant selected. A passing composite is
  everyone's pass. If it fails, a participant that did not ask for every
  package and every filter in the composite is requeued and runs its own
  request alone, so the result it reports is its own. The leader ticket
  keeps the composite exit: if it failed but your own tests look green in
  the output, check whether a co-batched package or filter failed before
  touching your code. Compile batches likewise keep a shared `--` trailer
  (`cargo clippy … -- -D warnings`) once; a participant whose own units
  compiled cleanly is released as done even when another's warnings fail
  the composite.
  The lane briefly holds a batchable head (150ms by default) so requests
  launched together can fold before the first process starts; set
  `CARGO_HAULER_BATCH_WINDOW_MS=0` to disable that window.
- If the daemon is unreachable, fail open: run the original cargo command.
- Optional PATH shim (`hauler install-shim`) catches cargo inside scripts.
  Its submissions show as `host=shim` in the ledger and the dashboard's who
  column — scripted or terminal cargo, not an agent hook rewrite.
- Daemon-spawned cargo bypasses the shim automatically
  (`CARGO_HAULER_INSIDE`), so brokered work never re-enters the broker —
  no need to strip the shim from PATH or probe for recursion.

## Workflow

1. Check `hauler status --session <id>` (or filtered `hauler_status`)
   before starting cargo. An unfiltered status is for machine-wide diagnosis.
2. Reuse an in-flight identical or covering run instead of launching another.
3. After a scoped change, wait on that ticket rather than re-running the same
   command in another subagent.
4. If Stop is denied because a ticket is pending, wait or call `hauler_await`
   — do not kill cargo. Stop again to keep waiting.
