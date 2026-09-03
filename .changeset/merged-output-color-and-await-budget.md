---
"cargo-hauler": patch
---

Merged-output runs (`cargo run 2>&1`, a shared terminal) strip cargo's captured color when the shared descriptor is not a color-capable TTY, matching direct cargo's `auto`, and the merge is honoured in passthrough runs too. `hauler await` / `hauler_await` subtract the time already spent fetching the ticket snapshot from the daemon wait, so the worst case stays under the render session. A failed run times its own intent for retries but no longer feeds the per-crate priors shared with other intents.
