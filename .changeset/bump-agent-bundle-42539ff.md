---
'cargo-hauler': patch
---

Bump `agent-bundle` and `@agent-bundle/runtime` to the pkg.pr.new preview at `42539ff5f`. With agent-bundle#461 a pass-through `tool/before` result no longer auto-approves, so the hook now answers `allow` only when every command in the input was rewritten onto (or already runs through) the hauler exec path, `continue` + `updatedInput` when a rewritten cargo command shares the input with something the daemon does not govern (`cd … && cargo build`, `cargo test | tail`), and plain `continue` (no decision) for every other tool call; it never returns `ask`. Accept the `confirmed` lineage resolution (agent-bundle#486) in ticket attribution.
