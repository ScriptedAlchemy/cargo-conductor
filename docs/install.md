# Installing cargo-conductor

cargo-conductor is an [agent-bundle](https://github.com/ScriptedAlchemy/agent-bundle)
plugin. The compile target is `plugin`, which emits Claude, Codex, and Cursor
into one artifact.

## Build

```sh
npm install
npm run check
```

`artifact/plugin` is the installable multi-host bundle (or `npm run dev` and
open the portable target in the workbench playground).

## Per-host notes

### Claude Code

- Install:

  ```sh
  claude plugin marketplace add ./artifact/plugin
  claude plugin install cargo-conductor@cargo-conductor-marketplace
  ```

- Hook events: `PreToolUse`, `PostToolUse`, `Stop`.
- Per-hook timeouts in `hooks.json` are honored. `beforeTool`/`afterTool` are
  10s; `stop` is 900s. The stop-hold implementation still bounds each wait
  to ~30s and re-denies so a single hook process never becomes a marathon.
- Claude's shell tool has historically killed cargo around 10 minutes. The
  client auto-backgrounds when the cost-model ETA exceeds 9 minutes.

### Cursor

- Install by symlinking the bundle into the local plugins directory:

  ```sh
  ln -s "$(pwd)/artifact/plugin" ~/.cursor/plugins/local/cargo-conductor
  ```

- Hook events: `preToolUse`, `postToolUse`. Cursor drops `beforeTool`
  additionalContext but honors `afterTool` context injection.
- The plugin target's Cursor wrappers live next to the Claude/Codex ones
  (`*.cursor.mjs`).

### Codex CLI

- Install:

  ```sh
  codex plugin marketplace add ./artifact/plugin
  codex plugin add cargo-conductor@cargo-conductor-marketplace
  ```

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
conductor install-shim            # defaults to ~/.local/bin
conductor install-shim --dir DIR  # or pick another user-writable dir
```

The shim only works if its directory resolves `cargo` **before** rustup's
`~/.cargo/bin` on `PATH`. Prepend it in your shell profile:

```sh
export PATH="$HOME/.local/bin:$PATH"
```

`install-shim` checks this after installing and warns when `cargo` still
resolves elsewhere (or when the directory is not on `PATH` at all).

The generated shim is self-contained
([issue #2](https://github.com/ScriptedAlchemy/cargo-conductor/issues/2): it
used to call a bare `conductor` that nothing puts on PATH):

- It embeds the absolute `node <script>` invocation of the CLI that ran
  `install-shim`, so it needs no `conductor` on PATH.
- It embeds an absolute real-cargo path. `--real-cargo` accepts a name or a
  path; names resolve through PATH at install time, skipping the shim
  directory itself, so re-installing with the shim already on PATH cannot
  embed a self-call. An existing `cargo` at the destination is only replaced
  with `--force`.
- It submits with `--host shim`, so ledger rows and the dashboard's who
  column show which requests entered through the shim rather than a hook
  rewrite (`claude`/`codex`/`cursor`).
- It passes daemon-spawned cargo straight through: the daemon sets
  `CARGO_CONDUCTOR_INSIDE=1` on every process it spawns, and the shim execs
  the real cargo directly when that variable is present, so the broker's own
  work never re-enters the broker.

On the daemon side, bare `cargo` argv (hook rewrites) and the internal
`cargo metadata` topology refresh never resolve through PATH, where the shim
sits. The daemon uses `CARGO_CONDUCTOR_CARGO_BIN` when set, otherwise
`$CARGO_HOME/bin/cargo` (default `~/.cargo/bin/cargo`), otherwise a bare
`cargo` as the last resort.

## State

Daemon socket and ledger live under a per-user cache directory:
`$XDG_CACHE_HOME/cargo-conductor` when `XDG_CACHE_HOME` is set, otherwise
`~/.cache/cargo-conductor` on Linux, `~/Library/Caches/cargo-conductor` on
macOS, and `%LOCALAPPDATA%\cargo-conductor` on Windows. Set
`CARGO_CONDUCTOR_STATE_DIR` to relocate it (a RAM disk or other fast mount is
optional, never required). `CARGO_CONDUCTOR_KACHE_INDEX` likewise overrides
the kache index location, which defaults to `kache/index.db` under the same
cache base and is simply reported unavailable when absent.
