---
'cargo-hauler': patch
---

Make daemon replacement directional. Upgrading with long-lived sessions still on a previous plugin produced a war: the old clients shut down the new daemon on every hook call (and failed to start their own), the new clients started it again, and no daemon lived longer than two seconds. Now only a newer install replaces a daemon. The `shutdown` request carries the client's version; the daemon refuses a shutdown from a client older than itself or from one that sends no version (`shutdown-refused`), and a client that finds a newer daemon fails as `DaemonNewer` without touching it: `hauler exec` runs cargo directly with that reason, hooks continue, and `hauler status` / `hauler daemon status` name the newer daemon. `hauler daemon stop` from an older install is refused the same way.
