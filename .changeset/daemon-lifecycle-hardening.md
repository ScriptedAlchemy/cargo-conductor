---
"cargo-hauler": patch
---

Harden the daemon's socket and singleton-lock lifecycle. The daemon now listens on `daemon.sock.<pid>` and atomically renames it over `daemon.sock`, so a daemon that lost socket ownership no longer deletes its replacement's socket on the way out (previously both daemons died and their in-flight tickets were reaped as orphaned). `hauler daemon run` acquires the singleton lock before opening the ledger, running migrations, or draining the passthrough spool, so a losing instance touches neither; it re-checks a held lock about once a second for up to ~20 s instead of giving up on the first look, treats a lock written before the current boot as stale whatever its recorded pid, treats a pid it cannot signal (`EPERM`) as unknown rather than alive, and reclaims a stale lock atomically so two cold starters can no longer both start. A second Ctrl-C during shutdown is now swallowed instead of skipping finalizers and leaving the lock and socket behind (#50)
