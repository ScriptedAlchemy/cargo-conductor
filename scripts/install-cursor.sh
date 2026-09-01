#!/usr/bin/env bash
# Install (or refresh) the built plugin artifact as a Cursor local plugin.
#
# Cursor's local-plugin loader reads a ROOT plugin.json / mcp.json and a
# Cursor-format hooks/hooks.json from ~/.cursor/plugins/local/<name>; it does
# not read the artifact's .cursor-plugin/ manifest (agent-bundle issue #126).
# Hook commands go through tiny shims that pin the plugin-root env and are
# regenerated on every install because wrapper filenames are content-hashed.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
artifact="${1:-$repo_root/artifact/plugin}"
dest="${CURSOR_PLUGINS_DIR:-$HOME/.cursor/plugins/local}/cargo-hauler"
node_bin="$(command -v node)"

[ -f "$artifact/plugin.json" ] || [ -d "$artifact/hooks" ] || {
  echo "no built artifact at $artifact; run npm run build first" >&2
  exit 1
}

resolve_wrapper() {
  local pattern="$1" match
  match=$(ls "$artifact"/hooks/$pattern 2>/dev/null | head -1)
  [ -n "$match" ] || { echo "missing hook wrapper $pattern in $artifact/hooks" >&2; exit 1; }
  echo "$match"
}

before_wrapper="$(resolve_wrapper 'before-tool-*.cursor.mjs')"
after_wrapper="$(resolve_wrapper 'after-tool-*.cursor.mjs')"
stop_wrapper="$(resolve_wrapper 'stop-*.cursor.mjs')"

rm -rf "$dest"
mkdir -p "$dest/hooks"

version="$(node -e "console.log(require('$artifact/.cursor-plugin/plugin.json').version)" 2>/dev/null || echo 0.0.0)"

cat > "$dest/plugin.json" <<MANIFEST
{
  "name": "cargo-hauler",
  "displayName": "cargo-hauler",
  "description": "Coalesce, schedule, and stream cargo so concurrent agent sessions share compiles instead of fighting locks.",
  "version": "$version",
  "author": { "name": "ScriptedAlchemy" },
  "hooks": "hooks/hooks.json",
  "skills": "skills/"
}
MANIFEST

write_shim() {
  local name="$1" wrapper="$2"
  cat > "$dest/hooks/$name.sh" <<SHIM
#!/bin/sh
export AGENT_BUNDLE_PLUGIN_ROOT="$artifact"
export CURSOR_PLUGIN_ROOT="$artifact"
exec "$node_bin" "$wrapper"
SHIM
  chmod 755 "$dest/hooks/$name.sh"
}

write_shim before "$before_wrapper"
write_shim after "$after_wrapper"
write_shim stop "$stop_wrapper"

cat > "$dest/hooks/hooks.json" <<HOOKS
{
  "version": 1,
  "hooks": {
    "preToolUse": [{ "command": "$dest/hooks/before.sh", "matcher": "^Shell$", "timeout": 10 }],
    "postToolUse": [{ "command": "$dest/hooks/after.sh", "matcher": "^Shell$", "timeout": 10 }],
    "stop": [{ "command": "$dest/hooks/stop.sh", "timeout": 900 }]
  }
}
HOOKS

mcp_entry="$(ls "$artifact"/mcp/mcp-hauler-*.mjs 2>/dev/null | head -1 || true)"
[ -n "$mcp_entry" ] || {
  echo "missing MCP entry mcp-hauler-*.mjs in $artifact/mcp" >&2
  exit 1
}
cat > "$dest/mcp.json" <<MCP
{
  "mcpServers": {
    "hauler": {
      "command": "$node_bin",
      "args": ["$mcp_entry"],
      "env": { "AGENT_BUNDLE_PLUGIN_ROOT": "$artifact" }
    }
  }
}
MCP

cp -r "$artifact/skills" "$dest/skills"
[ -d "$artifact/mcp-apps" ] && cp -r "$artifact/mcp-apps" "$dest/mcp-apps"

echo "installed Cursor plugin at $dest (artifact: $artifact)"
echo "restart Cursor (or reload) so new agent sessions pick up the hooks"
