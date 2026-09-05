---
'cargo-hauler': patch
---

Model `env NAME=value … cargo …` and `bash -c '… cargo …'` requests as the cargo they run (#126). A leading `env` (assignments, `-u NAME`) is folded into the request environment and intent key, so such requests get the right subcommand, packages, estimate, identity/coverage attachment, batching, demux, and execution-phase hand-back instead of being recorded as subcommand `env` with a default estimate. A `bash -c` / `sh -c` / `zsh -c` script with exactly one cargo statement is scheduled, estimated, and phase-tracked as that cargo tail, but never attaches, leads, or folds (the script may do more than its cargo), and is never demuxed. `env -i` stays opaque; other `env` options are refused as non-cargo programs.
