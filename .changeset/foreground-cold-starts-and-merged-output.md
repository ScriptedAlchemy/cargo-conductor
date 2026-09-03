---
"cargo-hauler": patch
---

`hauler exec` (and the PATH shim) no longer converts a synchronous request to a background ticket on a cold-start estimate: only a measured ETA (`etaSource` `ewma` or `kache`, now carried on the ack) can exceed the host shell cap, so a compile error on a fresh crate reaches the caller instead of exit 0 (#37). When a request is auto-backgrounded it exits `75` (`EX_TEMPFAIL`) and says so; explicit `--bg` keeps exit 0. The shim borrows `CARGO_HAULER_HOST`'s cap when exported, failed runs feed the estimate history, and the client now waits for the daemon's `detach-result` before hanging up so a still-queued ticket is not killed as abandoned.

`hauler await` / `hauler_await` bound one call to 55 s (`maxWaitMs` ceiling), under the framework's 60 s render session; longer waits used to fail with `Agent render elapsed time exceeds 60000ms` and lose the result (#32). Guidance, the skill, and the README say to call again.

Brokered output preserves the program's stdout/stderr write order when the caller's two descriptors are one file (`cargo run 2>&1`, a shared terminal): the client sends `mergeStderr` and the daemon runs the child with stderr on the stdout pipe. Demultiplexed `build`/`check`/`clippy` runs keep separate channels (#38).
