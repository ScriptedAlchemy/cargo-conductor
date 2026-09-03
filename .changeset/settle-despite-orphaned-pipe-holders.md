---
"cargo-hauler": patch
---

A ticket settles once its cargo process exits even when a surviving descendant (an orphaned helper or a daemonized child) keeps the output pipe open: the daemon drains for one more second, then stops reading instead of waiting for pipe EOF indefinitely.
