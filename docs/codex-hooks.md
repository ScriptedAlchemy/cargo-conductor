# Codex hook timeout verification

Status: **unverified on Codex 0.147**.

What we know from generated artifacts and Claude/Cursor:

- agent-bundle writes the same `timeout` field Codex's schema accepts.
- cargo-conductor sets `stop.timeout = 900`.
- The stop-hold hook never waits the full 900s. Each invocation waits
  `min(ETA, 30s)` then denies with status + ETA so the host re-enters.

Manual probe (when a Codex binary is available):

1. Start the daemon and submit `conductor exec --session probe -- cargo check`
   against a slow crate (or `FAKE_SLEEP=120` in tests).
2. Trigger Stop in Codex while the ticket is running.
3. Confirm the hook process lives at least the bounded wait and returns a
   deny reason containing the ticket id.
4. If Codex kills the hook sooner, set `CARGO_CONDUCTOR_STOP_WAIT_MS=8000`
   and rely on re-deny. Record any `~/.codex/config.toml` override that
   raises the native cap.
