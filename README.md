# cargo-conductor

An [agent-bundle](https://github.com/ScriptedAlchemy/agent-bundle) plugin that
orchestrates `cargo` across Claude Code, Codex CLI, and Cursor. Concurrent
sessions attach to shared work instead of fighting target-dir and package-cache
locks.

## Commands

```sh
npm run dev        # local workbench with live rebuilds
npm run build      # write host artifacts to artifact/
npm run check      # validate + build + typecheck + test
```

## Layout

- `agent-bundle.config.ts` — plugin meta, hosts, hooks, MCP, and the CLI script.
- `src/hooks/` — `beforeTool` / `afterTool` shell interception (fail-open).
- `src/cli.ts` — package bin and the `conductor` artifact script.
- `src/mcp/conductor.ts` — conventional stdio MCP entry.
- `skills/cargo-conductor/SKILL.md` — agent guidance (do not kill cargo, scope
  with `-p`, await tickets).

The compile target is `plugin` (one bundle for Claude, Codex, and Cursor).
Listing `claude`, `cursor`, and `plugin` together currently fails artifact
validation (AB6017): those names are the same length, so MCP entries are
mis-attributed across targets.

Daemon state lives under `/fast/cache/cargo-conductor/`.

## The agent-bundle dependency

agent-bundle has no npm release yet. This repo pins a
[pkg.pr.new](https://pkg.pr.new) preview tarball. The plan asked for
`3f8f08fc` (then main HEAD); that SHA had no published preview at scaffold
time, so the pin is the latest green main SHA that did:
[`560124af`](https://github.com/ScriptedAlchemy/agent-bundle/commit/560124af).
See
[Preview packages](https://github.com/ScriptedAlchemy/agent-bundle/blob/main/docs/preview-packages.md)
for the URL forms.
