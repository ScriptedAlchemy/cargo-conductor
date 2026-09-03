import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'effect-rstest';
import { expectDocument, renderRoute, renderRouteEvents, testManifest } from 'agent-bundle/test';
import * as Effect from 'effect/Effect';

import type { DaemonConfigShape } from '../../src/daemon/config.js';
import { requestOverSocket } from '../../src/daemon/control.js';
import type { RequestRecord } from '../../src/daemon/protocol.js';
import { scopedDaemon } from '../harness.js';

/**
 * Route-unit proof: the hauler routes render the Agent Documents they claim,
 * through the framework compiler's own route compilation (no artifact build).
 * Daemon-backed cases run a real broker in-process and hand its config to the
 * routes through the `daemonConfig` provider seam.
 */
const manifest = testManifest();

const withProvider = (config: DaemonConfigShape) => ({
  context: { providers: { daemonConfig: config } },
});

const withIsolatedStateDir = async <A>(body: () => Promise<A>): Promise<A> => {
  const root = mkdtempSync(join(tmpdir(), 'hauler-route-unit-'));
  const previous = process.env.CARGO_HAULER_STATE_DIR;
  process.env.CARGO_HAULER_STATE_DIR = join(root, 'state');
  try {
    return await body();
  } finally {
    if (previous === undefined) {
      delete process.env.CARGO_HAULER_STATE_DIR;
    } else {
      process.env.CARGO_HAULER_STATE_DIR = previous;
    }
    rmSync(root, { recursive: true, force: true });
  }
};

const fakeCargoEnv = (binDir: string): Record<string, string> => ({
  CARGO_HAULER_CARGO_BIN: join(binDir, 'cargo'),
  PATH: `${binDir}:${process.env.PATH ?? ''}`,
});

describe('route manifest', () => {
  it('compiles every hauler surface with no build and no errors', () => {
    expect(manifest.proofLevel).toBe('route-unit');
    expect(manifest.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')).toEqual([]);
    const routes = Object.keys(manifest.routes);
    for (const id of [
      'tool:hauler/hauler_status',
      'tool:hauler/hauler_log',
      'tool:hauler/hauler_last',
      'tool:hauler/hauler_await',
      'tool:hauler/hauler_result',
      'tool:hauler/hauler_request',
      'event:tool/before',
      'event:tool/after',
      'event:stop',
      'cli:status',
      'cli:log',
      'cli:last',
      'cli:await',
      'cli:result',
      'cli:request',
      'cli:daemon',
    ]) {
      expect(routes).toContain(id);
    }
  });
});

describe('tool documents without a daemon', () => {
  it('renders status as a stopped daemon with nothing in flight', async () => {
    await withIsolatedStateDir(async () => {
      const rendered = await renderRoute('tool:hauler/hauler_status', { input: {} });
      expectDocument(rendered)
        .toHaveStatus('success')
        .toContainText('daemon is not running')
        .toContainText('Nothing queued or running.')
        .toContainMarkdown('**Daemon:** stopped');
      expect(rendered.result).toMatchObject({ active: [], daemon: 'stopped', operation: 'status' });
    });
  });

  it('renders log and last as empty ledgers', async () => {
    await withIsolatedStateDir(async () => {
      const log = await renderRoute('tool:hauler/hauler_log', { input: { limit: 5 } });
      expectDocument(log).toHaveStatus('success').toContainText('no hauler requests recorded');
      expect(log.result).toMatchObject({ operation: 'log', requests: [] });

      const last = await renderRoute('tool:hauler/hauler_last', { input: {} });
      expectDocument(last).toHaveStatus('success').toContainText('no hauler requests recorded');
      expect(last.result).toMatchObject({ operation: 'last', request: null });
    });
  });

  it('fails ticket lookups loudly when the daemon is unreachable instead of faking not-found', async () => {
    await withIsolatedStateDir(async () => {
      await expect(
        renderRoute('tool:hauler/hauler_result', { input: { ticket: 'cc-1' } }),
      ).rejects.toThrow('daemon unreachable');
    });
  });
});

describe('tool documents against a live daemon', () => {
  it.live('submits a request, streams await progress, and shows the ticket in status', () =>
      Effect.gen(function* () {
        const fixture = yield* scopedDaemon(2);
        // Background submits carry no env, so the job is started over the
        // socket with the fake cargo pinned; the routes then observe it.
        const ack = yield* requestOverSocket({
          isTerminal: (message) => message.type === 'ack' || message.type === 'error',
          message: {
            argv: ['cargo', 'check', '-p', 'ws1'],
            background: true,
            cwd: fixture.ws1,
            env: { ...fakeCargoEnv(fixture.binDir), FAKE_SLEEP: '1' },
            host: 'test',
            id: 'route-unit-1',
            session: 's-1',
            type: 'exec',
          },
          socketPath: fixture.config.socketPath,
          timeoutMs: 8_000,
        });
        const acked = ack.find((message) => message.type === 'ack');
        if (acked === undefined || acked.type !== 'ack') {
          throw new Error(`daemon did not ack: ${JSON.stringify(ack)}`);
        }
        const ticket = acked.ticket;

        yield* Effect.promise(async () => {
          const submitted = await renderRoute('tool:hauler/hauler_request', {
            ...withProvider(fixture.config),
            input: { argv: ['cargo', 'check', '-p', 'ws1'], cwd: fixture.ws1, host: 'test', session: 's-1' },
          });
          // Identical request while the first runs: the broker attaches it,
          // and the document still hands the agent a ticket to wait on.
          const attached = (submitted.result as { readonly ticket: string | null }).ticket;
          expect(attached).toMatch(/^cc-\d+$/u);
          expectDocument(submitted)
            .toHaveStatus('success')
            .toContainText(`${attached} submitted`)
            .toContainContext(`hauler_await ${attached}`);

          const status = await renderRoute('tool:hauler/hauler_status', {
            ...withProvider(fixture.config),
            input: { session: 's-1' },
          });
          const statusValue = status.result as { readonly active: readonly RequestRecord[]; readonly daemon: string };
          expect(statusValue.daemon).toBe('running');
          expect([...statusValue.active.map((record) => record.ticket)]).toContain(ticket);
          expectDocument(status).toContainMarkdown('In flight').toContainContext('Do not start a duplicate');

          const awaited = await renderRouteEvents('tool:hauler/hauler_await', {
            ...withProvider(fixture.config),
            input: { maxWaitMs: 20_000, ticket },
          });
          const awaitedValue = awaited.result as {
            readonly request: RequestRecord | null;
            readonly timedOut: boolean;
          };
          expect(awaitedValue.timedOut).toBe(false);
          expect(awaitedValue.request?.status).toBe('done');
          expect(awaited.progress.length).toBeGreaterThan(0);
          expect(awaited.progress.every((update) => update.total === 20_000)).toBe(true);
          expectDocument(awaited)
            .toHaveStatus('success')
            .toContainMarkdown(ticket)
            .toContainContext(`${ticket} succeeded`);

          const fetched = await renderRoute('tool:hauler/hauler_result', {
            ...withProvider(fixture.config),
            input: { ticket },
          });
          expect(fetched.result).toMatchObject({ operation: 'result', ticket });
          expectDocument(fetched).toHaveStatus('success').toContainContext(`${ticket} succeeded`);
        });
      }), 30_000);
});
