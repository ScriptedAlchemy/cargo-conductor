---
'cargo-hauler': patch
---

Detect stalled tickets and end orphaned ones. The daemon samples every running ticket's process-tree CPU time (Linux `/proc`, macOS `ps`) and flags a run `stalled` once it is past `CARGO_HAULER_STALL_ESTIMATE_FACTOR` (3) times its estimate with no CPU and no output for `CARGO_HAULER_STALL_IDLE_MS` (10 min). `hauler status` / `hauler_status`, the dashboard, and `hauler await` heartbeats show `stalled` with the idle duration; `hauler result` / `hauler_result` answer `ticket looks stalled (no CPU for Nm) — hauler kill cc-N`. A stalled ticket whose submitting connection has disconnected is killed automatically through the `hauler kill` path with the error `stalled: no CPU for Nm after owner disconnected; killed automatically`; `CARGO_HAULER_STALL_AUTO_KILL=0` only flags. Status records gain optional `stall` and `orphaned` fields. (#46)
