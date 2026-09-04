---
'cargo-hauler': patch
---

Bump `agent-bundle` and `@agent-bundle/runtime` to the pkg.pr.new preview at `42539ff5f`. With agent-bundle#461 a pass-through `tool/before` result no longer auto-approves, so the hook now answers `allow` only for a cargo command it rewrote onto the hauler exec path and plain `continue` (no decision) for every other tool call; it never returns `ask`. Accept the `confirmed` lineage resolution (agent-bundle#486) in ticket attribution.
