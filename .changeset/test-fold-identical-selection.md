---
"cargo-hauler": patch
---

Fold `cargo test` / `cargo nextest run` requests only when their test selection is identical — same `--test` targets, name filters, arguments after `--`, and nextest filterset — so a composite runs exactly what each participant asked for over the union of their packages (`cargo test -p a` + `cargo test -p b` → `cargo test -p a -p b --no-fail-fast`), never a foreign target or filter. When a composite fails, a folded participant inherits the failure only if it named every package the composite ran; otherwise it is requeued and runs alone instead of reporting another package's failure as its own. Unmodeled post-subcommand options that take a value (`-j`/`--jobs`, `--color`, `--message-format`, `-Z`, `--config`, and nextest's `--retries`, `--test-threads`, `-P`, …) now consume that value instead of recording it as a test-name filter (#53).
