---
'cargo-hauler': patch
---

Serve `hauler dashboard` through `spawnServeApp` from `agent-bundle/serve-app-command` instead of hand-rolled child-process plumbing, and re-pin the `agent-bundle` / `@agent-bundle/runtime` preview to main `d30d9acb6` (agent-bundle #582 `serve-app-command` + `AB4837`, #588 package `dist/` held to `AB6005`). Flags (`--target`, `--port`, `--no-open`), the opening `hauler_status` call, and the checkout-only scope are unchanged; the helper's typed failures (`framework-not-installed`, `artifact-missing`, `spawn-failed`, `exited-before-ready` with the child's exit code, `aborted`, `stop-failed`) become the command's message, and a Ctrl-C whose stop the server refuses now ends the command with that failure instead of hanging. (#122)
