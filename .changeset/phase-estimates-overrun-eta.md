---
'cargo-hauler': minor
---

Estimate compile and execute separately, and keep a realistic queue ETA when a live head overruns.

`hauler status` reports `compileEstimateMs`, `executeEstimateMs`, and the current `phase` on a ticket. Followers waiting on a `test`/`nextest`/`bench`/`run` head see only the remaining execution time in `queue.waitEtaMs` (zero once overlap has handed the lane back), and queued tickets ahead of them count only their compile when overlap will hand the lane back. A head that has passed `CARGO_HAULER_STALL_ESTIMATE_FACTOR` times its estimate but is still burning CPU or printing is flagged `estimateState: overrun` with the intent's p90 (`p90Ms`), and its followers see `queue.headEstimateState: overrun`; its remaining time is re-estimated from that p90 — never less than one more estimate's worth — instead of contributing zero to the queue. A silent no-CPU head stays `stalled`. Filtered `--test <name>` runs with no history of their own borrow a same-package neighbor's timing before falling back to the crate-wide prior.
