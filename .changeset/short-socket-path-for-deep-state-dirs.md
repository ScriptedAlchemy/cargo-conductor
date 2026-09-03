---
"cargo-hauler": patch
---

When `CARGO_HAULER_STATE_DIR` is too deep for a unix socket path (103 bytes on macOS, 107 on Linux), the daemon socket moves to `$XDG_RUNTIME_DIR` / `$TMPDIR` as `cargo-hauler-<digest>.sock` instead of silently failing to bind; every client resolving the same state dir agrees on the endpoint.
