import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from '@rstest/core';
import { invokeMcpTool, listMcpSurface, openInMemoryMcpServer } from 'agent-bundle/test';

import { APP_RESOURCE_URI } from '../../src/constants.js';

/**
 * mcp-in-memory proof: the generated `hauler` server registers exactly the
 * tool names the skills and README teach, and `hauler_status` advertises the
 * dashboard resource so hosts can open the MCP App next to the result. (App
 * HTML itself is a browser build output and is not registered at this level.)
 */
it('pins the hauler tool names and the dashboard resource link', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hauler-mcp-surface-'));
  const previous = process.env.CARGO_HAULER_STATE_DIR;
  process.env.CARGO_HAULER_STATE_DIR = join(root, 'state');
  try {
    const surface = await listMcpSurface({ server: 'hauler' });
    expect([...surface.tools].sort()).toEqual([
      'hauler_await',
      'hauler_last',
      'hauler_log',
      'hauler_request',
      'hauler_result',
      'hauler_status',
    ]);

    const session = await openInMemoryMcpServer({ server: 'hauler' });
    try {
      const listed = await session.client.listTools();
      const status = listed.tools.find((tool) => tool.name === 'hauler_status');
      expect(status?._meta).toMatchObject({ ui: { resourceUri: APP_RESOURCE_URI } });
      expect(status?.annotations).toMatchObject({ readOnlyHint: true });
    } finally {
      await session.close();
    }

    const result = await invokeMcpTool('hauler_status', { input: {}, server: 'hauler' });
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({ daemon: 'stopped', operation: 'status' });
  } finally {
    if (previous === undefined) {
      delete process.env.CARGO_HAULER_STATE_DIR;
    } else {
      process.env.CARGO_HAULER_STATE_DIR = previous;
    }
    rmSync(root, { recursive: true, force: true });
  }
});
