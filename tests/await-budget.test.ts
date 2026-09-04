import { MAX_ROUTE_RENDER_ELAPSED_MS } from 'agent-bundle';
import { describe, expect, it } from 'effect-rstest';

import { config as cliAwaitConfig } from '../src/cli/await.js';
import { awaitCeilingMs } from '../src/daemon/protocol.js';
import { awaitMaxWaitMessage, ticketInputSchema } from '../src/lib/protocol-schemas.js';
import { config as toolAwaitConfig } from '../src/mcp/hauler/tools/hauler_await.js';

/**
 * One `await` call waits up to the daemon's ceiling (issues #3, #32). The two
 * rendered routes declare a `config.render.maxElapsedMs` (agent-bundle#454)
 * that covers that whole wait plus the snapshot fetch before it and the
 * socket round trip after it — the literal in each config is what the
 * compiler reads, so this test holds it to `awaitCeilingMs`.
 */
describe('await render budget', () => {
  it.each([
    ['cli:await', cliAwaitConfig.render.maxElapsedMs],
    ['tool:hauler/hauler_await', toolAwaitConfig.render.maxElapsedMs],
  ])('%s covers the daemon await ceiling with transport headroom', (_route, maxElapsedMs) => {
    expect(maxElapsedMs).toBeGreaterThan(awaitCeilingMs);
    expect(maxElapsedMs - awaitCeilingMs).toBeLessThanOrEqual(60_000);
    expect(maxElapsedMs).toBeLessThanOrEqual(MAX_ROUTE_RENDER_ELAPSED_MS);
  });

  it('caps maxWaitMs at the daemon ceiling, not the framework default', () => {
    expect(ticketInputSchema.parse({ maxWaitMs: awaitCeilingMs, ticket: 'cc-1' }).maxWaitMs).toBe(awaitCeilingMs);
    expect(ticketInputSchema.parse({ maxWaitMs: 90_000, ticket: 'cc-1' }).maxWaitMs).toBe(90_000);
    expect(() => ticketInputSchema.parse({ maxWaitMs: awaitCeilingMs + 1, ticket: 'cc-1' })).toThrow(
      awaitMaxWaitMessage,
    );
  });
});
