import { available, unavailable } from '@agent-bundle/runtime';
import { describe, expect, it } from 'effect-rstest';
import { cliJson, expectDocument, invokeCli, invokeMcpTool, renderRoute } from 'agent-bundle/test';

import { documentMetadata, withIsolatedStateDir } from './support.js';

/**
 * The hauler shell (`src/layout.tsx`) composes around every rendered route:
 * daemon badge on top, the route's own document unchanged in the middle,
 * lineage footer at the bottom, and `_meta.hauler` on the wire. These tests
 * pin that contract at the route-unit, cli-dispatch, and mcp-in-memory levels.
 */
describe('hauler shell layout', () => {
  it('names the requesting conversation in the footer and in _meta when the host provides lineage', async () => {
    await withIsolatedStateDir(async () => {
      const rendered = await renderRoute('tool:hauler/hauler_status', {
        context: {
          host: available({ name: 'cursor' }, 'native'),
          lineage: available(
            { conversation: 'conv-child', depth: 1, parent: 'conv-root', resolution: 'registry', root: 'conv-root' },
            'native',
          ),
        },
        input: {},
      });
      expectDocument(rendered)
        .toHaveStatus('success')
        .toContainContext('Requested by conversation conv-child (depth 1 under conv-root via conv-root; registry)');
      expect(documentMetadata(rendered.document)).toMatchObject({
        hauler: {
          lineage: { conversation: 'conv-child', depth: 1, root: 'conv-root' },
          route: 'tool:hauler/hauler_status',
          surface: 'tool',
        },
      });
    });
  });

  it('stays silent about lineage the host cannot place, instead of inventing one', async () => {
    await withIsolatedStateDir(async () => {
      const rendered = await renderRoute('tool:hauler/hauler_last', {
        context: { lineage: unavailable('id-not-resolvable') },
        input: {},
      });
      const contexts = JSON.stringify(rendered.document.root);
      expect(contexts).not.toContain('Requested by');
      expect(documentMetadata(rendered.document)).toMatchObject({ hauler: { lineage: null } });
    });
  });

  it('renders honestly with the daemon provider absent: no badge, unmounted in _meta', async () => {
    await withIsolatedStateDir(async () => {
      const rendered = await renderRoute('tool:hauler/hauler_log', {
        // An explicit map mounts verbatim; the conventional provider does not run.
        context: { providers: {} as never },
        input: { limit: 1 },
      });
      expect(JSON.stringify(rendered.document.root)).not.toContain('cargo-hauler · daemon');
      expect(documentMetadata(rendered.document)).toMatchObject({ hauler: { daemon: { state: 'unmounted' } } });
      expect(rendered.result).toMatchObject({ operation: 'log', requests: [] });
    });
  });

  it('projects the shell metadata as CallToolResult._meta over the in-memory MCP transport', async () => {
    await withIsolatedStateDir(async () => {
      const result = await invokeMcpTool('hauler_status', { input: {}, server: 'hauler' });
      expect(result.isError).toBe(false);
      expect(result._meta).toMatchObject({
        hauler: {
          daemon: { state: 'stopped' },
          route: 'tool:hauler/hauler_status',
          server: 'mcp:hauler',
          surface: 'tool',
        },
      });
      expect(result.structuredContent).toMatchObject({ daemon: 'stopped', operation: 'status' });
      const text = result.content.map((block) => ('text' in block ? block.text : '')).join('\n');
      expect(text).toContain('cargo-hauler · daemon stopped');
    });
  });

  it('wraps the rendered CLI Markdown with the same shell and leaves --json as the bare value', async () => {
    await withIsolatedStateDir(async () => {
      const markdown = await invokeCli(['status']);
      expect(markdown.exitCode).toBe(0);
      expect(markdown.stdout).toContain('cargo-hauler · daemon stopped');
      expect(markdown.stdout).toContain('Dashboard: ui://cargo-hauler/dashboard.html');

      const json = await invokeCli(['status', '--json']);
      expect(json.exitCode).toBe(0);
      expect(cliJson(json)).toMatchObject({ daemon: 'stopped', operation: 'status' });
      expect(Object.keys(cliJson(json) as Record<string, unknown>)).not.toContain('hauler');
    });
  });
});
