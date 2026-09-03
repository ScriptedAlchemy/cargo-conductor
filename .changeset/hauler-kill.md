---
"cargo-hauler": patch
---

Add `hauler kill <ticket>` and the `hauler_kill` tool: a queued ticket is dropped, a running one has its cargo process group terminated (SIGTERM, then SIGKILL after `CARGO_HAULER_KILL_GRACE_MS`) and its lane freed, with riders settled by the daemon. The skill and session context now say to use it instead of killing cargo PIDs (#46). The `maxWaitMs` ceiling on `await` is reported in plain words rather than a raw validator payload (#47).
