---
"cargo-hauler": patch
---

Paths are canonicalized through their nearest existing ancestor, so a target directory spells the same before and after cargo creates it (macOS `/var` → `/private/var`); lane keys and coverage attachment no longer diverge between a leader and its followers (#35, #36).
