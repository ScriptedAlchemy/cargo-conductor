---
"cargo-hauler": patch
---

Honour `hauler kill` for a job parked at the admission gate or on the permit semaphore (it settles `killed` at once instead of blocking its lane until a permit frees), never fold a kill-requested queued job into a batch, clamp the queue ETA so an overrunning lane head no longer cancels queued work and count a head parked at the gate, and finish every settlement step (waiters, lane release, follower exits) even when a ledger write fails. Late attachers receive each replayed chunk exactly once, a follower whose leader exits during registration stays settled (attach/running ledger writes never reopen a terminal row), an early follower release can no longer surface as a `pump failed` cargo termination, and identity attach requires callers to agree on `mergeStderr`. When the shared jobserver FIFO is armed the daemon no longer sets `CARGO_BUILD_JOBS`; `CARGO_HAULER_JOBS_GRANT` applies only while the FIFO is unavailable. (#51, #52, #54)
