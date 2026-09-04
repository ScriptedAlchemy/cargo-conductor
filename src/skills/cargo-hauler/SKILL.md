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
- Scope work with `-p <crate>` instead of workspace-wide `--all-features` when
  a single crate answers the question.
- Prefer `hauler status`, `hauler last`, and the `hauler_status` MCP
  tool over `ps`/`pgrep` probes.
- Do not pipe status through `jq` just to find your work. Scope it directly:
  `hauler status --session <id>`, `--cwd <path>`, repeated
  `--ticket cc-N`, `--status running`, or `--command-contains <text>`.
  `hauler_status` accepts the equivalent structured fields.
- Do not hand-roll `CARGO_TARGET_DIR` isolation or scratch clones to dodge
  locks. The daemon already serializes per (workspace, target dir); a private
  target dir only defeats attach/coverage sharing and multiplies compiles.
- Long builds: `hauler exec --bg -- cargo …` or `hauler_request`.
  Wait with `hauler await cc-N --max-wait-ms 55000` (each call waits at most
  55 s, the rendered-route budget; call it again to keep waiting), or call
  `hauler_await` with the same `maxWaitMs`; do not hand-roll a tight
  `hauler_result` polling loop. `hauler result cc-N` /
  `hauler_result` is for a point-in-time read and includes the live output
  tail while a run is still in progress. The dashboard drawer refreshes that
  tail every three seconds.
- Folded test runs share one process. Queued `cargo test` /
  `cargo nextest run` requests with the same test selection (targets,
  filters, arguments after `--`, filterset) but different packages may fold
  into one composite run over the union of their packages with
  `--no-fail-fast`; every participant gets the composite's full output. A
  passing composite is everyone's pass. If it fails, a participant that did
  not name every package in the composite is requeued and runs its own
  request alone, so the result it reports is its own. The leader ticket
  keeps the composite exit: if it failed but your own tests look green in
  the output, check whether a co-batched package failed before touching
  your code.
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
