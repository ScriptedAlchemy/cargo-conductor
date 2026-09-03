import { agent } from '@agent-bundle/runtime';
import type { ToolConfig, ToolRouteProps } from 'agent-bundle';
import React from 'react';

import { LastDocument } from '../../../components/documents.js';
import { mcpSurface } from '../../../components/surface.js';
import { loadLastResult } from '../../../lib/inspect.js';
import { lastResultSchema, limitInputSchema } from '../../../lib/protocol-schemas.js';
import { requestDaemonConfig } from '../../../lib/request-config.js';

export const config = {
  annotations: { readOnlyHint: true },
  description: 'Show the most recent cargo-hauler request with its output tail and outcome.',
  title: 'Hauler last request',
} satisfies ToolConfig;

export const inputSchema = limitInputSchema;
export const resultSchema = lastResultSchema;

export default async function HaulerLast({ signal }: ToolRouteProps<typeof inputSchema>) {
  const context = await agent();
  const last = await loadLastResult({ config: requestDaemonConfig(context), signal });
  return <LastDocument names={mcpSurface} nowMs={Date.now()} result={last} />;
}
