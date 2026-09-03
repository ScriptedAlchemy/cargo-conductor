# Installing cargo-hauler

cargo-hauler is an [agent-bundle](https://github.com/ScriptedAlchemy/agent-bundle)
application. `pnpm run build` emits one independently installable host pack per
target — `artifact/claude`, `artifact/codex`, `artifact/cursor`, and the
Agent Plugins `artifact/portable` — plus the package binaries in `dist/bin/`
(`hauler.js`, `cargo-hauler.js`, and the generated `cargo-hauler-install.js`).

Supported platforms: Linux and macOS. Windows is experimental and untested
(the daemon endpoint resolves to a named pipe, but the cargo PATH shim is
POSIX-only and refuses to install). Node >= 22.19 is required (`node:sqlite`).

## Build

```sh
pnpm install
pnpm run build   # or `pnpm run check` to also run the typecheck and test gate
```

Every pack ships the same surfaces: `mcp/` (the `hauler` MCP server), `hooks/`
(the four event routes in the host's own hook document), `skills/`,
`scripts/hauler.mjs` (the `exec` / `daemon` / `install-shim` entry the hooks
rewrite Cargo to), `bin/cargo-hauler.mjs` (the routed CLI: `status`, `log`,
`last`, `await`, `result`, `request`, `daemon`), `mcp-apps/dashboard.html`,
and an `INSTALL.md` with the exact compiled names.

## Install with the framework installer

The packs are framework-owned and install through `agent-bundle install`; the
project has no installer of its own. Run from the repository root:

```sh
pnpm exec agent-bundle install claude --from artifact/claude --scope user
pnpm exec agent-bundle install codex  --from artifact/codex
pnpm exec agent-bundle install cursor --from artifact/cursor --mode local
```

- `--replace` (alias `--force`) replaces a different installed version or
  adopts a pre-receipt copy; a same-version rebuild is replaced in place
  (owned files only, `state/` survives).
- `agent-bundle doctor --host <host>` reports the installed copy versus the
  artifact as `current`, `stale`, `version-mismatch`, `foreign`, or
  `not-installed`.
- From an `npm pack`ed tarball, `npx cargo-hauler-install install <host>
  [--scope …] [--mode …] [--json]` performs the same operations
  (`dist/bin/cargo-hauler-install.js`); `npm install` itself never mutates a
  host.

## Per-host notes

### Claude Code

- The installer adds the pack as a local marketplace and installs
  `cargo-hauler@cargo-hauler-marketplace` at the requested scope (`user`,
  `project`, or `local`). The pack's `INSTALL.md` lists the equivalent
  `claude plugin marketplace add` / `claude plugin install` commands.
- Hook events: `SessionStart`, `PreToolUse`, `PostToolUse`, `Stop` (matcher
  `^Bash$` for the tool hooks). Timeouts: 5 s, 10 s, 10 s, 900 s. The
  stop-hold implementation bounds each wait to ~30 s and re-denies, so a
  single hook process never becomes a marathon.
- Claude's shell tool has historically killed cargo around 10 minutes. The
  client auto-backgrounds when the cost-model ETA exceeds 9 minutes.

### Cursor

- `--mode local` (default) safe-copies the pack into
  `~/.cursor/plugins/local/cargo-hauler`, records an install receipt, and
  refuses foreign directories. Cursor registers the plugin's hooks from the
  manifest alone (`hooks/hooks.json`): `sessionStart`, `preToolUse` and
  `postToolUse` (matcher `^Shell$`), and `stop`. Reload Cursor
  (`Developer: Reload Window`) so new sessions pick them up.
- `--mode marketplace` stages a committed Git repository at
  `~/.cursor/agent-bundle/marketplaces/cargo-hauler` and prints the one
  Cursor-owned step: Customize → Plugins → Add Plugins from Local Repository →
  select that directory → Install. `agent-bundle doctor --host cursor` reports
  whether the staged marketplace was imported.
- `agent-bundle doctor --host cursor` also reports each local plugin's hook
  registration (`AB7322`) and warns about duplicate delivery through
  `~/.cursor/hooks.json` (`AB7323`).
- The PATH shim (below) additionally covers Cargo that Cursor runs outside
  the hooked shell tool.

### Codex CLI

- The installer adds the pack as a local marketplace snapshot and installs
  `cargo-hauler@cargo-hauler-marketplace`.
- Hook schema mirrors Claude (`SessionStart` / `PreToolUse` / `PostToolUse` /
  `Stop`).
- Stop-hook behavior is **verified on Codex 0.147.0** by a live probe: holds
  of ~29 s and ~72 s ran to their own wait bound and delivered their deny
  intact, and the re-deny loop (`stopHookActive` re-entry) works. Details and
  quirks in [codex-hooks.md](codex-hooks.md).
- **Hook trust gates everything**: without persisted trust in
  `~/.codex/config.toml` (`[hooks.state]`) or
  `--dangerously-bypass-hook-trust`, Codex does not run the hooks at all.
- If a Stop hook is ever cut off mid-hold anyway: shorten the in-hook wait
  (`CARGO_HAULER_STOP_WAIT_MS`, default 30000) and rely on the re-deny loop.

### Portable (Agent Plugins 1.0.0)

`artifact/portable` is the open-standard pack: skills and the MCP server only
(the standard defines no hooks), loaded natively by Cursor, Codex, VS Code,
GitHub Copilot, Kiro, and ChatGPT, and used by the agent-bundle Workbench
playground. It also carries an `install.mjs` for Cursor-compatible hosts.

## Optional PATH shim

Hooks cannot see `cargo` spawned from scripts. Install a shim from the package
binary; the shim embeds the absolute path of whichever `hauler` ran
`install-shim`:

```sh
node dist/bin/hauler.js install-shim            # defaults to ~/.local/bin
node dist/bin/hauler.js install-shim --dir DIR  # or pick another user-writable dir
```

`install-shim` refuses unknown flags instead of installing on, say, `--help`.
The shim only works if its directory resolves `cargo` **before** rustup's
`~/.cargo/bin` on `PATH`; prepend it in your shell profile
(`export PATH="$HOME/.local/bin:$PATH"`). `install-shim` checks this after
installing and warns when `cargo` still resolves elsewhere.

The generated shim is self-contained
([issue #2](https://github.com/ScriptedAlchemy/cargo-hauler/issues/2)): it
embeds the absolute `node <script>` invocation of the CLI that ran
`install-shim` and an absolute real-cargo path (the `~/.cargo/bin/cargo` link,
not its canonical rustup target — rustup dispatches on `argv[0]`). It submits
with `--host shim`, and passes daemon-spawned cargo straight through
(`CARGO_HAULER_INSIDE=1`). On the daemon side, bare `cargo` argv never
resolves through PATH: the daemon uses `CARGO_HAULER_CARGO_BIN` when set,
otherwise `$CARGO_HOME/bin/cargo`, otherwise a bare `cargo` as the last
resort.

## State

Daemon socket and ledger live under a per-user cache directory:
`$XDG_CACHE_HOME/cargo-hauler` when `XDG_CACHE_HOME` is set, otherwise
`~/.cache/cargo-hauler` on Linux, `~/Library/Caches/cargo-hauler` on
macOS, and `%LOCALAPPDATA%\cargo-hauler` on Windows. Set
`CARGO_HAULER_STATE_DIR` to relocate it. The pre-rename
`CARGO_CONDUCTOR_STATE_DIR` is not honored; hand-run commands warn when it is
still exported (see
[incidents/2026-09-01-state-identity-split-brain.md](incidents/2026-09-01-state-identity-split-brain.md)).

kache is optional. When `CARGO_HAULER_KACHE_INDEX` is unset, the daemon
reads kache's own config (`$XDG_CONFIG_HOME/kache/config.toml`, else
`~/.config/kache/config.toml`) for the `local_store` path under `[cache]` and
uses `<local_store>/index.db`; without that config it falls back to
`kache/index.db` under the same per-user cache base. An empty string disables
the lookup entirely; a missing file just reports kache as unavailable.
