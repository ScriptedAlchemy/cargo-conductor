# Installing cargo-conductor

cargo-conductor is an [agent-bundle](https://github.com/ScriptedAlchemy/agent-bundle)
plugin. The compile target is `plugin`, which emits Claude, Codex, and Cursor
into one artifact.

## Build

```sh
npm install
npm run check
```

Host adapters pick up `artifact/plugin`. Point each host at that directory
(or `npm run dev` and open the portable target in the workbench playground).

## Per-host notes

### Claude Code

- Hook events: `PreToolUse`, `PostToolUse`, `Stop`.
- Per-hook timeouts in `hooks.json` are honored. `beforeTool`/`afterTool` are
  10s; `stop` is 900s. The stop-hold implementation still bounds each wait
  to ~30s and re-denies so a single hook process never becomes a marathon.
- Claude's shell tool has historically killed cargo around 10 minutes. The
  client auto-backgrounds when the cost-model ETA exceeds 9 minutes.

### Cursor

- Hook events: `preToolUse`, `postToolUse`. Cursor drops `beforeTool`
  additionalContext but honors `afterTool` context injection.
- The plugin target's Cursor wrappers live next to the Claude/Codex ones
  (`*.cursor.mjs`).

### Codex CLI

- Hook schema mirrors Claude (`PreToolUse` / `PostToolUse` / `Stop`).
- Whether Codex 0.147 honors per-hook `timeout` is **unverified** in this
  repo. If a Stop hook is cut off mid-hold:
  1. Shorten the in-hook wait (`CARGO_CONDUCTOR_STOP_WAIT_MS`, default 30000).
  2. Rely on the re-deny loop: the next Stop re-enters with `stopHookActive`.
  3. If needed, raise the Codex hook budget in `~/.codex/config.toml`
     (host-specific; not generated here).
- Integration: `npm run test` covers native Codex PreToolUse envelopes on
  the generated wrapper. A live Codex Stop timeout probe is documented as
  a manual check, not a CI gate.

## Optional PATH shim

Hooks cannot see `cargo` spawned from scripts. Install a shim:

```sh
conductor install-shim --dir ~/.local/bin --real-cargo "$(command -v cargo)"
```

Prepend that directory to `PATH` so scripted cargo goes through the broker.

## State

Daemon socket and ledger live under `/fast/cache/cargo-conductor/` unless
`CARGO_CONDUCTOR_STATE_DIR` is set.
