---
"cargo-hauler": minor
---

Admission caps heavy leaders under low memory (#27): when `MemAvailable` is below `CARGO_HAULER_HEAVY_MEM_AVAILABLE_GB` (default 16 GiB, `off` to disable), at most `CARGO_HAULER_HEAVY_MAX_CONCURRENT` (default 1) release/perf/bench-profile or workspace-wide builds run at once. Held jobs report why in heartbeats, `hauler status`, and the dashboard (`admissionHold`, `heavy` in the load report). `cargo build -r` is now recognized as a release build for intent identity.

Non-compiling cargo subcommands (`fmt`, `update`, `fetch`, `add`, `remove`, `generate-lockfile`, `vendor`, `new`, `init`, `info`, `uninstall`) run locally instead of queueing for a permit.

The `hauler` script inside a host artifact forwards routed commands (`status`, `log`, `last`, `await`, `result`, `request`) to the bundled `bin/cargo-hauler.mjs`, so an installed plugin exposes the full CLI.

agent-bundle re-pinned to preview `4edbd493b`; the framework now provides the `agent-bundle/meta` test alias, script discovery alongside `bin` claims, and same-version installer replacement, so the local workarounds for those are removed.
