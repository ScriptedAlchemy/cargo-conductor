---
'cargo-hauler': patch
---

State precisely when `hauler install-shim` embeds the running npm entry instead of the PATH `hauler` (only when no `hauler` on PATH resolves to a `.js` script; version-manager shims do not count), in the README and in the command's own message, which no longer calls a self-embedded checkout entry "global" (#124)
