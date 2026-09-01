---
name: cargo-conductor
description: Orchestrate cargo through the conductor daemon — do not kill in-flight builds, scope with -p, and await tickets instead of re-running identical checks.
---
# cargo-conductor

Use this Skill whenever an agent is about to run `cargo` (check, test, build,
clippy, fmt, nextest) or is waiting on someone else's cargo.

## Rules

- Do not kill in-flight `cargo` processes. Attach or await the existing ticket.
- Scope work with `-p <crate>` instead of workspace-wide `--all-features` when
  a single crate answers the question.
- Prefer `conductor status`, `conductor last`, and the `conductor_status` MCP
  tool over `ps`/`pgrep` probes.
- Do not hand-roll `CARGO_TARGET_DIR` isolation or scratch clones to dodge
  locks. The daemon already serializes per (workspace, target dir); a private
  target dir only defeats attach/coverage sharing and multiplies compiles.
- Long builds: `conductor exec --bg -- cargo …` or `conductor_request`. Retrieve
  with `conductor_await` / `conductor_result` (or the afterTool notify).
- Folded test runs share one result. Queued compatible `cargo test` /
  `cargo nextest run` requests may fold into a single composite run (a
  superset of the participants' packages, targets, and filters, with
  `--no-fail-fast`), and every participant gets the composite's full output
  and exit code. If your ticket failed but your own tests look green in the
  output, check whether a co-batched test failed before touching your code.
- If the daemon is unreachable, fail open: run the original cargo command.
- Optional PATH shim (`conductor install-shim`) catches cargo inside scripts.
  Its submissions show as `host=shim` in the ledger and the dashboard's who
  column — scripted or terminal cargo, not an agent hook rewrite.
- Daemon-spawned cargo bypasses the shim automatically
  (`CARGO_CONDUCTOR_INSIDE`), so brokered work never re-enters the broker —
  no need to strip the shim from PATH or probe for recursion.

## Workflow

1. Check `conductor status` (or `conductor_status`) before starting cargo.
2. Reuse an in-flight identical or covering run instead of launching another.
3. After a scoped change, wait on that ticket rather than re-running the same
   command in another subagent.
4. If Stop is denied because a ticket is pending, wait or call `conductor_await`
   — do not kill cargo. Stop again to keep waiting.
