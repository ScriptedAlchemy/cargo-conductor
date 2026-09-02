# Incident: daemon split-brain and state-store identity loss

**Date:** 2026-09-01 (evening, US Pacific)
**Fixed in:** 0.2.6 (`fa38b14`), 0.2.7 (`bc58581`), 0.2.8 (`260e74d`)
**Impact:** no data loss; brief windows of misleading stats and duplicate daemons; zero in-flight cargo runs interrupted by remediation.

This is a walkthrough of two intertwined production incidents that surfaced hours
after the cargo-conductor → cargo-hauler rebrand, why they happened, and what
changed in the code as a result. Both incidents trace to one root theme:
**state identity must never be inferred from ambient conditions** — not from
lock-file mtimes, not from directory existence, and not from inherited legacy
environment variables.

## Background

Earlier the same day the project was rebranded from `cargo-conductor` to
`cargo-hauler` (PR #24, released as 0.2.0). The migration renamed the state
store on disk:

```
/fast/cache/cargo-conductor  →  /fast/cache/cargo-hauler
```

carrying the full SQLite ledger (986 rows at migration time) with it. The
daemon singleton at that point relied on `proper-lockfile` over
`daemon.pid`, and environment compatibility kept every legacy
`CARGO_CONDUCTOR_*` variable as a fallback for its `CARGO_HAULER_*`
replacement.

Both of those decisions turned out to have failure modes.

## Incident 1: singleton split-brain (fixed in 0.2.6)

### Symptom

`hauler daemon status` answered from daemon B (a fresh pid) while the pidfile
named daemon A — and `ps` showed both processes alive. A second daemon had
started underneath a live one. After remediation, restarted daemons also
stopped rewriting `daemon.pid`, so the pidfile pointed at a dead process.

### Root cause

`proper-lockfile` judges lock staleness by **mtime touch heartbeats** on the
lock directory. Moving the state directory during the rebrand broke the
original heartbeat path for the already-running daemon: its lock stopped
looking alive. The next `daemon start` saw a "stale" lock, stole it, and
started a second daemon — while the first kept running, socketless, still
believing it owned the store. PID records were never cleaned up on shutdown,
and socket cleanup was not ownership-aware, so the survivors disagreed about
who owned what.

### Fix (0.2.6)

- **Owner-aware stale recovery**: a lock is only breakable when its recorded
  owner pid is provably dead, never on mtime alone.
- **Fail-closed acquisition**: a daemon that cannot acquire the lock while a
  live daemon answers the socket exits with a clear message instead of
  running anyway.
- **PID hygiene**: every successfully started daemon rewrites `daemon.pid`
  under the held lock; shutdown removes socket and pid consistently.
- **Socket-inode self-monitoring**: a daemon that loses its socket file
  (replaced or unlinked beneath it) shuts itself down rather than lingering
  as a socketless zombie.

## Incident 2: the resurrected legacy store (fixed in 0.2.7 + 0.2.8)

### Symptom

Hours after the rebrand, `hauler daemon status` reported
`not running; 2 recorded requests` while the real ledger held 1,157 rows.
`/fast/cache/cargo-conductor` — deleted during migration — existed again,
containing a fresh, nearly-empty ledger. Metrics windows and savings read
zero. The daemon and CLI were reading an impostor store.

### Root cause (two layers)

1. **Environment, not code.** The host's login session persisted
   `CARGO_CONDUCTOR_STATE_DIR=/fast/cache/cargo-conductor` in
   `~/.config/environment.d/60-cargo-conductor.conf`, imported by the systemd
   user manager at login and inherited by every IDE-spawned shell. The
   variable predated the rebrand and pointed at the dead path.
2. **Compat honored it.** The rebrand kept `CARGO_CONDUCTOR_STATE_DIR` as an
   explicit-env fallback. Any process inheriting the stale variable resolved
   the dead path and — because the daemon auto-creates its state dir —
   faithfully resurrected it with an empty ledger. From then on, every
   similarly-contaminated process preferred the impostor.

### Fix

- **0.2.7**: removed the toxic resolution in production, reconciled the
  stores (the impostor held only two synthetic probe rows; nothing worth
  merging), deleted the resurrected directory, and restarted one daemon on
  the canonical store.
- **Host environment**: `60-cargo-conductor.conf` replaced by
  `60-cargo-hauler.conf` setting `CARGO_HAULER_STATE_DIR` /
  `CARGO_HAULER_KACHE_INDEX`; systemd user environment updated. Already
  running sessions keep the stale variable until re-login — which motivated
  the final layer:
- **0.2.8**: the code no longer honors `CARGO_CONDUCTOR_STATE_DIR` at all. A
  detected legacy variable produces a one-line deprecation warning naming its
  replacement. Verified by simulating the incident: a shell exporting only
  the legacy variable resolves the canonical store and cannot create the dead
  path.

### The compat rule that came out of it

Legacy `CARGO_CONDUCTOR_*` aliases remain honored **only where a stale value
cannot corrupt state identity**:

| Category | Examples | Legacy alias |
| --- | --- | --- |
| State/socket/db location | `*_STATE_DIR` | **removed** (0.2.8) |
| Read-only data paths | `*_KACHE_INDEX` | kept |
| Tuning and thresholds | `*_MAX_CONCURRENT`, `*_BATCH*`, pressure knobs | kept |
| Metadata | host/session attribution | kept |

## Timeline (US Pacific)

| Time | Event |
| --- | --- |
| ~16:15 | Rebrand migration: store renamed, 0.2.0 deployed, old daemon drained cleanly |
| 19:11 | `daemon start` steals a live daemon's "stale" lock → split-brain observed |
| 19:20–19:42 | Root cause + fix shipped as 0.2.6; legacy daemons retired childless |
| ~19:21 | Contaminated shells begin resurrecting `/fast/cache/cargo-conductor` |
| 20:58 | Stats read near-zero → impostor store discovered |
| 21:16 | 0.2.7: resolution fixed, stores reconciled, canonical daemon restored |
| 21:23 | Persisted env located in `environment.d` and corrected |
| 21:35 | 0.2.8: legacy state-dir variable dropped in code; incident closed |

## Lessons

1. **Identity from explicit configuration only.** Directory existence, lock
   mtimes, and inherited environment are all ambient state; none of them may
   decide which store a daemon owns.
2. **Fail closed on singletons.** A daemon that cannot prove exclusive
   ownership must refuse to run — a missing daemon is a visible failure, a
   duplicate daemon is a silent one.
3. **Migrations must hunt their environment.** Renaming on-disk state is not
   complete until every persisted reference (profiles, `environment.d`,
   systemd user env, already-running sessions) is accounted for.
4. **Compat aliases need a corruption test.** "Still honor the old name" is
   only safe for values whose staleness degrades gracefully. For state
   identity, compat *was* the bug.
5. **Durable ledgers make incidents boring.** Because every request is a
   ledger row, the blast radius was measurable in minutes (two synthetic rows
   in the impostor store) and history — 916 runs, 144 riders served, 8.5+
   hours of compute avoided — survived untouched.
