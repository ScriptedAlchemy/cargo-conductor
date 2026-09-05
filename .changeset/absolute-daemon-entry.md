---
'cargo-hauler': patch
---

Spawn the daemon from an absolute entry path. The daemon runs with the state dir as its cwd, so a relative entry (a host running the plugin script from its own directory, or a relative plugin root) resolved to `<state dir>/scripts/hauler.mjs` and every start died with `MODULE_NOT_FOUND`; with version gating that repeated on each hook call after an upgrade. The entry is now resolved against the client's cwd and checked for existence, falling back to the package entry beside the bundled module and only then to the running script.
