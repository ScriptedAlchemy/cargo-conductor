import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'effect-rstest';
import {
  openPackedMcpServer,
  runPackedContractMatrix,
  testManifest,
  type ContractRouteFixture,
} from 'agent-bundle/test';
import * as Data from 'effect/Data';
import * as Effect from 'effect/Effect';
import * as Schedule from 'effect/Schedule';

import { fetchTicket } from '../../src/client/tickets.js';
import { requestOverSocket } from '../../src/daemon/control.js';
import type { RequestRecord } from '../../src/daemon/protocol.js';
import { type Fixture, scopedDaemon } from '../harness.js';

/**
 * Packed-stdio proof: the built `artifact/cursor` MCP entry runs as a separate
 * process over real stdio, against a real broker, and every tool route passes
 * the framework's wire-contract matrix (surface completeness including the
 * dashboard resource, successful-path sweep with bundled resultSchema
 * validation, advertised input-schema rejection, cancellation hygiene).
 *
 * The artifact is `pnpm run build` output; `pnpm run check` builds first. The
 * daemon is the in-process fixture broker, reached by the packed server
 * through `CARGO_HAULER_STATE_DIR`.
 */
const projectRoot = resolve(import.meta.dirname, '../..');
const pluginRoot = join(projectRoot, 'artifact', 'cursor');

interface McpJson {
  readonly mcpServers: Readonly<
    Record<string, { readonly args: readonly [string, ...string[]]; readonly env?: Readonly<Record<string, string>> }>
  >;
}

const packedEntry = (): { readonly entry: string; readonly env: Record<string, string> } => {
  const mcpJson = JSON.parse(readFileSync(join(pluginRoot, 'mcp.json'), 'utf8')) as McpJson;
  const server = mcpJson.mcpServers['hauler'];
  if (server === undefined) {
    throw new Error('artifact/cursor/mcp.json does not declare the hauler server');
  }
  // Cursor expands ${CURSOR_PLUGIN_ROOT} before spawning; the test stands in.
  const expand = (value: string): string => value.replaceAll('${CURSOR_PLUGIN_ROOT}', pluginRoot);
  return {
    entry: expand(server.args[0]),
    env: Object.fromEntries(Object.entries(server.env ?? {}).map(([key, value]) => [key, expand(value)])),
  };
};

/** Submits one background fake-cargo job over the socket and returns its ticket. */
const submitJob = (
  fixture: Fixture,
  id: string,
  extraEnv: Record<string, string> = {},
): Effect.Effect<string, unknown> =>
  Effect.gen(function* () {
    const ack = yield* requestOverSocket({
      isTerminal: (message) => message.type === 'ack' || message.type === 'error',
      message: {
        argv: ['cargo', 'check', '-p', id],
        background: true,
        cwd: fixture.ws1,
        env: {
          CARGO_HAULER_CARGO_BIN: join(fixture.binDir, 'cargo'),
          PATH: `${fixture.binDir}:${process.env.PATH ?? ''}`,
          ...extraEnv,
        },
        host: 'packed-contract',
        id: `packed-contract-${id}`,
        session: 'packed-1',
        type: 'exec',
      },
      socketPath: fixture.config.socketPath,
      timeoutMs: 8_000,
    });
    const acked = ack.find((message) => message.type === 'ack');
    if (acked === undefined || acked.type !== 'ack') {
      throw new Error(`daemon did not ack: ${JSON.stringify(ack)}`);
    }
    return acked.ticket;
  });

class TicketStillActive extends Data.TaggedError('TicketStillActive')<{
  readonly ticket: string;
  readonly status: string;
}> {}

/** A ticket whose job has already finished. */
const finishedTicket = (fixture: Fixture): Effect.Effect<string, unknown> =>
  Effect.gen(function* () {
    const ticket = yield* submitJob(fixture, 'done');
    yield* fetchTicket(ticket, fixture.config).pipe(
      Effect.flatMap((record: RequestRecord | null) =>
        record === null || record.status === 'requested' || record.status === 'queued' || record.status === 'running'
          ? new TicketStillActive({ status: record?.status ?? 'unknown', ticket })
          : Effect.void,
      ),
      Effect.retry(Schedule.spaced('50 millis').pipe(Schedule.upTo({ times: 200 }))),
    );
    return ticket;
  });

const fixturesFor = (
  fixture: Fixture,
  tickets: { readonly finished: string; readonly running: string },
): Record<string, ContractRouteFixture> => ({
  // The dashboard is a resource: no input, but the coverage check wants an entry.
  'app:hauler/dashboard': {},
  'tool:hauler/hauler_await': {
    // Cancellation must catch the call mid-wait, so it awaits the long job.
    cancellation: { abortAfterMs: 100, input: { maxWaitMs: 20_000, ticket: tickets.running } },
    input: { maxWaitMs: 1_000, ticket: tickets.finished },
    resultCompat: 'additive',
  },
  // Killing an unknown ticket is a no-op answer, so the matrix stays hermetic.
  'tool:hauler/hauler_kill': { input: { ticket: 'cc-999999' }, resultCompat: 'additive' },
  'tool:hauler/hauler_last': { input: {}, resultCompat: 'additive' },
  'tool:hauler/hauler_log': { input: { limit: 5 }, inputs: [{}], resultCompat: 'additive' },
  'tool:hauler/hauler_request': {
    input: { argv: ['cargo', 'check', '-p', 'ws1'], cwd: fixture.ws1, host: 'packed-contract', session: 'packed-2' },
    resultCompat: 'additive',
  },
  'tool:hauler/hauler_result': {
    input: { ticket: tickets.finished },
    inputs: [{ ticket: tickets.running }, { full: true, ticket: tickets.finished }],
    resultCompat: 'additive',
  },
  'tool:hauler/hauler_status': {
    input: {},
    inputs: [{ limit: 5, statuses: ['done'] }, { session: 'packed-1' }],
    resultCompat: 'additive',
  },
});

describe('packed stdio contract', () => {
  it.live.skipIf(!existsSync(join(pluginRoot, 'mcp.json')))(
    'runs the built hauler server as a process and passes the contract matrix for every tool',
    () =>
      Effect.gen(function* () {
        const fixture = yield* scopedDaemon(2);
        // Background submits carry no env, so the daemon resolves cargo itself;
        // pin it at the fake for the duration of this process.
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            const previous = process.env.CARGO_HAULER_CARGO_BIN;
            process.env.CARGO_HAULER_CARGO_BIN = join(fixture.binDir, 'cargo');
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
        const finished = yield* finishedTicket(fixture);
        const running = yield* submitJob(fixture, 'slow', { FAKE_SLEEP: '20' });
        const packed = packedEntry();
        const session = yield* Effect.acquireRelease(
          Effect.promise(() =>
            openPackedMcpServer({
              cwd: fixture.ws1,
              entry: packed.entry,
              env: {
                ...(process.env as Record<string, string>),
                ...packed.env,
                CARGO_HAULER_KACHE_INDEX: '',
                CARGO_HAULER_STATE_DIR: fixture.config.stateDir,
              },
              name: 'hauler-packed-contract',
            }),
          ),
          (open) => Effect.promise(() => open.close()),
        );
        expect(session.provenance.proofLevel).toBe('packed-stdio');

        const tools = yield* Effect.promise(() => session.client.listTools());
        expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
          'hauler_await',
          'hauler_kill',
          'hauler_last',
          'hauler_log',
          'hauler_request',
          'hauler_result',
          'hauler_status',
        ]);
        const resources = yield* Effect.promise(() => session.client.listResources());
        expect(resources.resources).toEqual(
          expect.arrayContaining([expect.objectContaining({ uri: 'ui://cargo-hauler/dashboard.html' })]),
        );

        const report = yield* Effect.promise(() =>
          runPackedContractMatrix({
            fixtures: fixturesFor(fixture, { finished, running }),
            manifest: testManifest(),
            server: 'hauler',
            session,
          }),
        );
        expect(report.provenance.proofLevel).toBe('packed-stdio');
        const failed = Object.entries(report.routes).flatMap(([route, routeReport]) =>
          Object.entries(routeReport.checks)
            .filter(([, outcome]) => outcome.status === 'failed')
            .map(([check, outcome]) => `${route} ${check}: ${outcome.reason ?? ''}`),
        );
        expect(failed).toEqual([]);
      }),
    120_000,
  );
});
