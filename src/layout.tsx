import { Agent, useAgent, type AgentLayoutProps, type JsonValue } from '@agent-bundle/runtime';
import { version } from 'agent-bundle/meta';
import React from 'react';

import { DaemonBadge } from './components/daemon-badge.js';
import { LineageFooter } from './components/lineage-footer.js';
import { lineageModel } from './components/view-models.js';
import { requestDaemon } from './lib/request-config.js';

/**
 * The hauler shell. Every rendered surface — the six `hauler_*` MCP tools,
 * the rendered `cargo-hauler` CLI commands, and any rendered script — composes
 * through this one layout, so no route imports a wrapper to obtain the
 * standard document structure:
 *
 * - a header line saying what the daemon probe proved at request start and
 *   which state directory it is (`<DaemonBadge>` over the `haulerDaemon`
 *   provider);
 * - the route's own document, unchanged (its `Agent.Result value` merges up
 *   into this container, so `structuredContent` and the CLI `--json` value
 *   are exactly what the route declared);
 * - a footer naming the conversation the request belongs to
 *   (`<LineageFooter>`, `request.lineage`), when the host placed it in one.
 *
 * The container's `metadata` becomes `CallToolResult._meta.hauler` on MCP
 * hosts and the document metadata everywhere else: route identity, surface,
 * plugin version, daemon state, and lineage — enough for a host, a Workbench
 * document stage, or an `--ndjson` consumer to attribute every document.
 *
 * Event routes are host protocol responses and are never wrapped.
 */
export default function HaulerLayout({ children, route }: AgentLayoutProps) {
  const request = useAgent();
  const daemon = requestDaemon(request);
  const lineage = lineageModel(request.lineage);
  const nowMs = Date.now();
  const metadata: Record<string, JsonValue> = {
    hauler: {
      daemon: daemon === undefined
        ? { state: 'unmounted' }
        : daemon.health.state === 'running'
          ? { pid: daemon.health.pid, state: daemon.health.state, version: daemon.health.version }
          : { state: daemon.health.state },
      lineage: lineage === null
        ? null
        : { conversation: lineage.conversation, depth: lineage.depth, root: lineage.root },
      route: route.id,
      server: route.serverId ?? null,
      surface: route.kind,
      version,
    },
  };
  return (
    <Agent.Result metadata={metadata}>
      {daemon === undefined ? null : (
        <DaemonBadge health={daemon.health} nowMs={nowMs} stateDir={daemon.config.stateDir} />
      )}
      {children}
      <LineageFooter />
    </Agent.Result>
  );
}
