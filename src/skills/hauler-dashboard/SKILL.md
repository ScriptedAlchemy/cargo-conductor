---
name: hauler-dashboard
description: Use when opening, previewing, interpreting, or troubleshooting the cargo-hauler dashboard, its metrics windows, admission state, lanes, kache data, or live ticket output.
---
# hauler-dashboard

Use the dashboard for machine-wide fleet state. Use the `cargo-hauler` Skill
for submitting, scoping, or waiting on work.

## Open it

- **MCP App host:** call `hauler_status`. Hosts that render MCP Apps attach
  `ui://cargo-hauler/dashboard.html`.
- **Plain browser:** build the artifact, then start the live preview:

  ```sh
  npm run build
  node scripts/preview-dashboard.mjs --port 4941
  ```

  Open `http://127.0.0.1:4941`. The preview uses the production daemon and
  polls every five seconds.

## Read the panels

- **Contention:** machine load, CPU I/O wait, disk pressure, and admission
  permits. `3/5 +1 riding` means three real Cargo processes hold permits and
  one request is sharing existing work.
- **In flight / Queue:** active leaders and waiting tickets, including
  workspace, submitter, elapsed/wait time, and cost estimate.
- **Metrics:** switch among `1h`, `24h`, and `all`. Run counts, outcomes, and
  percentiles use the selected window. Compute avoided, latency saved, and
  riders served are all-time SQLite-ledger totals; negative latency is
  included.
- **Kache:** optional machine-wide cache freshness, active compile roots, and
  slowest crates grouped by profile. No panel means kache is unavailable or
  disabled, not that the daemon failed.
- **Lanes:** work grouped by resolved `(workspace root, target dir)`. Only
  lanes with queued or running work are active.
- **History:** finished tickets and the command each request actually ran as,
  including composite batch expansion.

Click an in-flight row to open its live output drawer. It refreshes every
three seconds. Completed and queued rows show their durable ledger state.

## Diagnose contention

1. Check the admission meter before assuming the daemon is stalled.
2. Match queued work to its lane and current leader.
3. Filter with `hauler status --session`, `--cwd`, `--ticket`, `--status`, or
   `--command-contains`; do not replace the dashboard with `ps` polling.
4. Await or attach to the ticket. Do not kill Cargo to clear a lane.
