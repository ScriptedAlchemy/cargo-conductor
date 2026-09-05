---
'cargo-hauler': patch
---

Lane scheduling prefers the compile surface the lane just built. A queued request whose profile, features, target, toolchain, or compile-relevant environment differ from the last leader's is scored as 1.5× its estimate, so consecutive requests that share a surface run back to back instead of alternating `cargo test` (test profile) with `cargo check`/`build` (dev profile) or flipping a feature set on every ticket. The ledger showed 47% of consecutive same-lane runs switching surface and those runs taking 1.6–2.5× as long as same-surface runs. Shortest-job-first, fan-out, edit fail-fast, and age escape still apply: a switch that is clearly cheaper still runs first, and a switching request cannot be starved.
