---
'cargo-hauler': minor
---

Cut the latency the hauler adds on a shared target directory, and stop charging lane wait to attaching.

- A lane now hands its slot to the next request as soon as a `test`, `nextest`, `bench`, or `run` leader prints Cargo's `Finished … target(s)` line: Cargo drops the build-directory lock there, so the next compile overlaps the leader's test run instead of waiting for it. The leader keeps its admission permit until it settles. `hauler status` and the dashboard list such leaders under the lane's `executing` tickets, and the ledger stamps `buildFinishedAtMs` on the leader and its riders. `CARGO_HAULER_OVERLAP_EXECUTION=0` restores strict one-process-per-lane.
- Default admission permits scale with the machine: one per eight cores, clamped between the previous five and sixteen. `CARGO_HAULER_MAX_CONCURRENT` still overrides.
- The cost model times edited and cached runs of an intent separately, and floors an edited intent that has only ever been timed cached at the crate compile priors, so a recompiling test run no longer reaches the head of the lane on a seconds-long estimate; unedited runs no longer teach the per-crate compile priors.
- Saved latency for riders is measured from the later of the rider's creation and the leader's start: time queued behind a leader that had not started is lane wait the rider would have paid alone, not a cost of attaching. Existing ledgers recompute the column once on open (`user_version` 2); the dashboard's all-time latency tile changes accordingly.
