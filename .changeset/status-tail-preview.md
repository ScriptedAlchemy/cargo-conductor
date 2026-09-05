---
'cargo-hauler': patch
---

Make `hauler status`, `hauler_status`, and `hauler log` rows bounded summaries that never carry an output tail; read a ticket's whole tail with `hauler result` / `hauler_result`, `hauler await`, or `hauler last`. (#95)

- The status document used to overlay every running ticket's whole in-memory tail (up to 16 KiB per running row) onto its status row, and the dashboard polls that document every 5 s. A status or log row is now a summary (`StatusRow`, `statusRowSchema`): no `outputTail`, settled or live. A running row carries `outputPreview`, the last 8 lines (at most 512 bytes) of its live output cut at a line boundary; every other row has `outputPreview: null`. The text rendering of `hauler status` never printed tails, so only `--json` / `structuredContent` readers see the difference.
- The whole tail is the detail contract: `hauler result <ticket>` / `hauler_result` and `hauler await` carry a finished ticket's settled 16 KiB tail or a running ticket's whole live tail, and `hauler result --full` the on-disk log. `hauler last` reads the newest ticket as a detail record — from the daemon while it is running, otherwise from the ledger — so it shows the tail again.
- The dashboard's in-flight rows show the last preview line under the command; the ticket drawer always fetches `hauler_result` and refreshes the tail every 3 s while the run is in progress, so a drawer opened from a summary row shows the whole output.
