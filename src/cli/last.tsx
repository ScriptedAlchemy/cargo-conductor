import { agent } from '@agent-bundle/runtime';
import type { CliRouteConfig, CliRouteProps } from 'agent-bundle';
import React from 'react';
import { z } from 'zod';

import { LastDocument } from '../components/documents.js';
import { cliSurface } from '../components/surface.js';
import { loadLastResult } from '../lib/inspect.js';
import { lastResultSchema } from '../lib/protocol-schemas.js';
import { requestDaemonConfig } from '../lib/request-config.js';

export const config = {
  description: 'Show the most recent hauler request with its output tail and outcome.',
} satisfies CliRouteConfig;

export const inputSchema = z.object({});

export const resultSchema = lastResultSchema;

export default async function Last({ signal }: CliRouteProps<typeof inputSchema>) {
  const context = await agent();
  const last = await loadLastResult({ config: requestDaemonConfig(context), signal });
  return <LastDocument names={cliSurface} nowMs={Date.now()} result={last} />;
}
