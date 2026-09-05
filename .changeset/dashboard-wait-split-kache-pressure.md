---
'cargo-hauler': minor
---

Show what the hauler costs, not only what it saves: queue wait vs run time per metrics window, the compile/execute split per command, and kache store pressure. (#92)

- Each metrics window (`1h`, `24h`, `all`) now reports total queue wait against total run time for leaders, and splits the wait by cause: *lane-bound* (a same-lane leader was still compiling — before its `Finished` line or exit), *permit-bound* (every admission permit was held and no same-lane compile was to blame), and *other* (admission holds, `--after` prerequisites, scheduling latency). The classification is a pure sweep over ledger rows, run against the daemon's current permit count; the tile states that assumption, since runs admitted under an earlier cap are classified against today's.
- With `buildFinishedAtMs` on the row, the by-command split adds compile vs execution p50s for `test`/`run`/`bench` leaders, and the window reports the lane time the execution-phase hand-back released. Pure compiles have no split and say nothing.
- The kache panel (`hauler status`, `hauler_status`, and the dashboard) surfaces store pressure: blob bytes recorded in the index against `local_max_size` (from `KACHE_MAX_SIZE` or kache's `config.toml`; "limit unknown" names why when it cannot be read), the last GC from `gc_stats.json` — when, how long, what it evicted — with any `gc: skipping eviction` warnings matched from kache's `auto-gc.log`/`daemon.log` during that run, and `key_ms` mean/p95 over the events tail. Warnings appear when the store is over its limit or the last GC declined or skipped evictions. Missing or unparsable files render as unavailable with their reason, never as an empty store.
- Protocol additions are optional fields (`metrics.windows[].waitSplit`, `handBack`, `runTotalMs`, `waitTotalMs`, `bySubcommand[].phases`, `kache.pressure`); clients reading an older daemon see the tiles as unavailable rather than as zeros.
