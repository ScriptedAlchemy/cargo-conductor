import { describe, expect, it } from 'effect-rstest';
import { invokeMcpTool, listMcpSurface, openInMemoryMcpServer } from 'agent-bundle/test';
import * as Effect from 'effect/Effect';

import { APP_RESOURCE_URI } from '../../src/constants.js';
import { scopedDaemon } from '../harness.js';

import { withIsolatedStateDir, withStateDir } from './support.js';

/**
 * mcp-in-memory proof: the generated `hauler` server registers exactly the
 * tool names the skills and README teach, `hauler_status` advertises the
 * dashboard resource so hosts can open the MCP App next to the result, and —
 * against an in-process fixture broker running a fake cargo — the tools
 * project real daemon state through the real MCP wire contract. (App HTML
 * itself is a browser build output and is not registered at this level.)
 */
const toolNames = ['hauler_await', 'hauler_last', 'hauler_log', 'hauler_request', 'hauler_result', 'hauler_status'];

describe('hauler MCP surface', () => {
  it('pins the hauler tool names and the dashboard resource link', async () => {
    await withIsolatedStateDir(async () => {
      const surface = await listMcpSurface({ server: 'hauler' });
      expect([...surface.tools].sort()).toEqual(toolNames);

      const session = await openInMemoryMcpServer({ server: 'hauler' });
      try {
        const listed = await session.client.listTools();
        const status = listed.tools.find((tool) => tool.name === 'hauler_status');
        expect(status?._meta).toMatchObject({ ui: { resourceUri: APP_RESOURCE_URI } });
        expect(status?.annotations).toMatchObject({ readOnlyHint: true });
        // Every hauler result is an object, so every tool advertises its outputSchema.
        expect(listed.tools.every((tool) => tool.outputSchema !== undefined)).toBe(true);
        const request = listed.tools.find((tool) => tool.name === 'hauler_request');
        expect(request?.annotations).toMatchObject({ readOnlyHint: false });
      } finally {
        await session.close();
      }

      const result = await invokeMcpTool('hauler_status', { input: {}, server: 'hauler' });
      expect(result.isError).toBe(false);
      expect(result.structuredContent).toMatchObject({ daemon: 'stopped', operation: 'status' });
    });
  });

  it.live('submits, lists, and reads a ticket over the in-memory transport against a live broker', () =>
    Effect.gen(function* () {
      const fixture = yield* scopedDaemon(1);
      // Background submits carry no env, so pin the fake cargo for the daemon.
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          const previous = process.env.CARGO_HAULER_CARGO_BIN;
          process.env.CARGO_HAULER_CARGO_BIN = `${fixture.binDir}/cargo`;
          return previous;
        }),
        (previous) =>
          Effect.sync(() => {
            if (previous === undefined) {
              delete process.env.CARGO_HAULER_CARGO_BIN;
            } else {
              process.env.CARGO_HAULER_CARGO_BIN = previous;
            }
          }),
      );
      yield* Effect.promise(() =>
        // The conventional provider resolves the fixture broker from the environment.
        withStateDir(fixture.config.stateDir, async () => {
          const session = await openInMemoryMcpServer({ server: 'hauler' });
          try {
            const submitted = await session.client.callTool({
              arguments: { argv: ['cargo', 'check', '-p', 'ws1'], cwd: fixture.ws1, session: 'mcp-1' },
              name: 'hauler_request',
            });
            expect(submitted.isError ?? false).toBe(false);
            const value = submitted.structuredContent as {
              readonly attribution: { readonly host: string; readonly session: string | null };
              readonly ticket: string | null;
            };
            expect(value.ticket).toMatch(/^cc-\d+$/u);
            expect(value.attribution).toMatchObject({ session: 'mcp-1' });
            expect(submitted._meta).toMatchObject({ hauler: { daemon: { state: 'running' }, route: 'tool:hauler/hauler_request' } });

            const status = await session.client.callTool({ arguments: { session: 'mcp-1' }, name: 'hauler_status' });
            const statusValue = status.structuredContent as {
              readonly daemon: string;
              readonly active: readonly { readonly ticket: string }[];
              readonly recent: readonly { readonly ticket: string }[];
            };
            expect(statusValue.daemon).toBe('running');
            expect([...statusValue.active, ...statusValue.recent].map((row) => row.ticket)).toContain(value.ticket);

            // A background submit carries no job env, so the daemon resolves
            // cargo itself (the real binary, which fails fast in the fixture
            // workspace): the proof here is that the wait settles and the
            // settled document — not the streaming fallback — reaches the wire.
            const awaited = await session.client.callTool({
              arguments: { maxWaitMs: 15_000, ticket: value.ticket },
              name: 'hauler_await',
            });
            const awaitedValue = awaited.structuredContent as {
              readonly request: { readonly status: string } | null;
              readonly timedOut: boolean;
            };
            expect(awaited.structuredContent).toMatchObject({ operation: 'await', ticket: value.ticket, timedOut: false });
            expect(['done', 'failed']).toContain(awaitedValue.request?.status);
            const text = (awaited.content as readonly { readonly type: string; readonly text?: string }[])
              .map((block) => block.text ?? '')
              .join('\n');
            expect(text).toContain(`### ${value.ticket} ${awaitedValue.request?.status}`);
            expect(text).not.toContain('Waiting up to');
            expect(awaited._meta).toMatchObject({ hauler: { route: 'tool:hauler/hauler_await' } });
          } finally {
            await session.close();
          }
        }));
    }), 40_000);
});
