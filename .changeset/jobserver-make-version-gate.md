---
"cargo-hauler": patch
---

The shared fifo jobserver is armed only when the host `make` can speak it (GNU make 4.4+, or no make at all); on older makes the daemon falls back to per-run `CARGO_BUILD_JOBS` grants so `-sys` crates whose build scripts run `make` (jemalloc, openssl, …) build again. `CARGO_HAULER_JOBSERVER=fifo|off|auto` overrides the detection (#76).
