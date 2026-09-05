---
'cargo-hauler': patch
---

Serialize `hook-state.json` read-modify-write cycles across concurrent sessions' hook processes with a lock beside the file (#110), so one session's completion cursor or stop-denial counter is no longer lost when another session's hook saves at the same moment. Waiting is bounded (2 s) and a lock that cannot be taken degrades to the previous unlocked update rather than failing the host's tool call; a lock older than 5 s is treated as abandoned.
