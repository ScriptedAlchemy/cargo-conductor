---
"cargo-hauler": patch
---

Internal simplification sweep: one socket-errno walker (`src/lib/socket-errors.ts`) serves the client, the health probe, and the hooks; `defaultCargoProfile`, the ms clamps, and `diagnosticCounts` are shared instead of copied; request statuses and attach modes are one `as const` list that feeds the types, the zod schemas, and the ledger's SQL filters; the ack is the broker's `SubmitResult` spread once; the before-shell hook skips the bash parse for commands that cannot name cargo, and the after-shell hook no longer rewrites its state file when no ticket finished. The `hauler await` heartbeat spells whole minutes as `2m` rather than `2m0s`.
