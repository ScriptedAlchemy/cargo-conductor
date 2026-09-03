# Installing cargo-hauler

cargo-hauler is an [agent-bundle](https://github.com/ScriptedAlchemy/agent-bundle)
plugin. The compile target is `plugin`, which emits Claude, Codex, and Cursor
into one artifact.

Supported platforms: Linux and macOS. Windows is experimental and untested
(the daemon endpoint resolves to a named pipe, but the cargo PATH shim is
POSIX-only and refuses to install). Node >= 22.19 is required (`node:sqlite`).

## Build

```sh
pnpm install
pnpm run build   # or `pnpm run check` to also run the typecheck and test gate
```

`artifact/plugin` is the installable multi-host bundle (or `pnpm run dev` and
open the portable target in the workbench playground). The same build writes
the package binaries to `dist/bin/`: `hauler.js` (process entry) and
`cargo-hauler.js` (routed CLI). The bundle's `scripts/hauler.mjs` handles
`exec`, `daemon`, and `install-shim` itself and forwards `status`, `log`,
`last`, `await`, `result`, and `request` to the bundle's `bin/cargo-hauler.mjs`.
The commands below assume you run them from `artifact/plugin`.

The bundle also ships `INSTALL.md` and `AGENTS.md` with the same commands for
the exact compiled version.

## Per-host notes

### Claude Code

- Install:

  ```sh
  claude plugin marketplace add ./
  claude plugin install cargo-hauler@cargo-hauler-marketplace --scope user
  ```

  Replace `user` with `project` or `local` for a narrower scope.

- Hook events: `PreToolUse`, `PostToolUse`, `Stop` (matcher `^Bash$` for the
  tool hooks).
- Per-hook timeouts in `hooks.json` are honored. `beforeTool`/`afterTool` are
  10s; `stop` is 900s. The stop-hold implementation still bounds each wait
  to ~30s and re-denies so a single hook process never becomes a marathon.
- Claude's shell tool has historically killed cargo around 10 minutes. The
  client auto-backgrounds when the cost-model ETA exceeds 9 minutes.

### Cursor

- Install with the bundle's own installer (Cursor has no non-interactive
  plugin install command, and it rejects symlinks that resolve outside
  `~/.cursor/plugins/local`, so the installer makes a physical copy):

  ```sh
  node ./install.mjs
  ```

  It installs into `~/.cursor/plugins/local/cargo-hauler` and refuses to
  overwrite a different version or different content — remove that directory
  first when refreshing after a rebuild. Restart or reload Cursor so new agent
  sessions pick up the hooks.

- Hook events declared in `hooks/hooks-cursor.json`: `preToolUse`,
  `postToolUse` (matcher `^Shell$`), and `stop`. Cursor drops `beforeTool`
  additionalContext but honors `afterTool` context injection.
- **Known limitation:** on current Cursor builds, plugin-manifest hooks do not
  fire for tool events (tracked upstream as
  [ScriptedAlchemy/agent-bundle#407](https://github.com/ScriptedAlchemy/agent-bundle/issues/407)).
  Until that lands, install the PATH shim (below); it is the effective
  interception for Cargo on Cursor. Codex and Claude Code hooks fire.
- The plugin target's Cursor wrappers live next to the Claude/Codex ones
  (`*.cursor.mjs`).

### Codex CLI

- Install:

  ```sh
  codex plugin marketplace add ./
  codex plugin add cargo-hauler@cargo-hauler-marketplace
  ```

- Hook schema mirrors Claude (`PreToolUse` / `PostToolUse` / `Stop`).
- Stop-hook behavior is **verified on Codex 0.147.0** by a live probe: holds
  of ~29s and ~72s ran to their own wait bound and delivered their deny
  intact, and the re-deny loop (`stopHookActive` re-entry) works. Budgets
  above ~72s are plausible but unmeasured. Details and quirks in
  [codex-hooks.md](codex-hooks.md).
- **Hook trust gates everything**: without persisted trust in
  `~/.codex/config.toml` (`[hooks.state]`) or
  `--dangerously-bypass-hook-trust`, Codex does not run the hooks at all.
- If a Stop hook is ever cut off mid-hold anyway:
  1. Shorten the in-hook wait (`CARGO_HAULER_STOP_WAIT_MS`, default 30000).
  2. Rely on the re-deny loop: the next Stop re-enters with `stopHookActive`.
- Integration: `pnpm test` covers native Codex PreToolUse envelopes on
  the generated wrapper. The live Codex Stop timeout probe is documented in
  [codex-hooks.md](codex-hooks.md), not a CI gate.

## Optional PATH shim

Hooks cannot see `cargo` spawned from scripts (and on Cursor they do not fire
at all today, see above). Install a shim from the package binary; the shim
embeds the absolute path of whichever `hauler` ran `install-shim`:

```sh
node dist/bin/hauler.js install-shim            # defaults to ~/.local/bin
node dist/bin/hauler.js install-shim --dir DIR  # or pick another user-writable dir
```

`install-shim` refuses unknown flags instead of installing on, say, `--help`.

The shim only works if its directory resolves `cargo` **before** rustup's
`~/.cargo/bin` on `PATH`. Prepend it in your shell profile:

```sh
export PATH="$HOME/.local/bin:$PATH"
```

`install-shim` checks this after installing and warns when `cargo` still
resolves elsewhere (or when the directory is not on `PATH` at all).

The generated shim is self-contained
([issue #2](https://github.com/ScriptedAlchemy/cargo-hauler/issues/2): it
used to call a bare `hauler` that nothing puts on PATH):

- It embeds the absolute `node <script>` invocation of the CLI that ran
  `install-shim`, so it needs no `hauler` on PATH.
- It embeds an absolute real-cargo path. `--real-cargo` accepts a name or a
  path; names resolve through PATH at install time, skipping the shim
  directory itself, so re-installing with the shim already on PATH cannot
  embed a self-call. The embedded path is the `~/.cargo/bin/cargo` link, not
  its canonical rustup target: rustup dispatches on `argv[0]`, and embedding
  the proxy binary turned `cargo check` into `rustup check` (fixed in 0.3.1).
  An existing `cargo` at the destination is only replaced with `--force`.
- It submits with `--host shim`, so ledger rows and the dashboard's who
  column show which requests entered through the shim rather than a hook
  rewrite (`claude`/`codex`/`cursor`).
- It passes daemon-spawned cargo straight through: the daemon sets
  `CARGO_HAULER_INSIDE=1` on every process it spawns, and the shim execs
  the real cargo directly when that variable is present, so the broker's own
  work never re-enters the broker.

On the daemon side, bare `cargo` argv (hook rewrites) and the internal
`cargo metadata` topology refresh never resolve through PATH, where the shim
sits. The daemon uses `CARGO_HAULER_CARGO_BIN` when set, otherwise
`$CARGO_HOME/bin/cargo` (default `~/.cargo/bin/cargo`), otherwise a bare
`cargo` as the last resort.

## State

Daemon socket and ledger live under a per-user cache directory:
`$XDG_CACHE_HOME/cargo-hauler` when `XDG_CACHE_HOME` is set, otherwise
`~/.cache/cargo-hauler` on Linux, `~/Library/Caches/cargo-hauler` on
macOS, and `%LOCALAPPDATA%\cargo-hauler` on Windows. Set
`CARGO_HAULER_STATE_DIR` to relocate it (a RAM disk or other fast mount is
optional, never required). The pre-rename `CARGO_CONDUCTOR_STATE_DIR` is not
honored; hand-run commands warn when it is still exported (see
[incidents/2026-09-01-state-identity-split-brain.md](incidents/2026-09-01-state-identity-split-brain.md)).

kache is optional. When `CARGO_HAULER_KACHE_INDEX` is unset, the daemon
reads kache's own config (`$XDG_CONFIG_HOME/kache/config.toml`, else
`~/.config/kache/config.toml`) for the `local_store` path under `[cache]` and
uses `<local_store>/index.db`; without that config it falls back to
`kache/index.db` under the same per-user cache base. An empty string disables
the lookup entirely; a missing file just reports kache as unavailable and the
scheduler uses its own EWMA/ledger priors.
