---
"cargo-hauler": patch
---

Align the plugin's remaining hand-synced surfaces with agent-bundle framework mode: the `hauler_status` tool and the dashboard MCP App route now read the widget URI from one imported `APP_RESOURCE_URI` const that the compiler resolves statically (no duplicated `ui://` literals), the App template is declared route-relative, and the unit-test pool takes its `agent-bundle/meta` alias from the framework's `agentBundleRstest` preset instead of a hand-written fixture. No runtime behavior changes.
