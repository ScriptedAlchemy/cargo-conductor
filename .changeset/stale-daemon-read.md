---
'cargo-hauler': patch
---

`hauler status`, `hauler daemon status`, `hauler log`, `hauler_status`, and the dashboard no longer die with a `ZodError` when the daemon that answers is from a previous install (#123). The read-only surfaces check the daemon's reported version before parsing its rows; a mismatch reads the ledger, marks the daemon `unresponsive`, and says which version is running and that the next cargo command or `hauler daemon restart` replaces it.
