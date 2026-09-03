import { DEFAULT_AGENT_RENDER_LIMITS } from '@agent-bundle/runtime';
import { describe, expect, it } from 'effect-rstest';

import { awaitMaxWaitMs } from '../src/lib/protocol-schemas.js';
import { awaitTransportSlackMs, renderBoundedWaitMs } from '../src/lib/tickets.js';

describe('renderBoundedWaitMs', () => {
  it('passes a short wait through when nothing has been spent yet', () => {
    expect(renderBoundedWaitMs(30_000, 0)).toBe(30_000);
  });

  it('shrinks the daemon wait by what the snapshot already spent, plus socket slack', () => {
    // 55 s ceiling, 4 s spent fetching the snapshot: 55 - 4 - slack.
    expect(renderBoundedWaitMs(awaitMaxWaitMs, 4_000)).toBe(
      awaitMaxWaitMs - 4_000 - awaitTransportSlackMs,
    );
  });

  it('never goes negative when the budget is already gone', () => {
    expect(renderBoundedWaitMs(awaitMaxWaitMs, 60_000)).toBe(0);
  });

  it('keeps the worst case under the framework render session', () => {
    // Provider probe (≤1.5 s) happens before the route clock starts; the
    // route then spends `elapsed` on the snapshot and `wait + slack` on the
    // daemon long-poll. Whatever the split, the total stays under 60 s.
    for (const elapsed of [0, 2_000, 4_500]) {
      const wait = renderBoundedWaitMs(awaitMaxWaitMs, elapsed);
      expect(1_500 + elapsed + wait + awaitTransportSlackMs).toBeLessThan(
        DEFAULT_AGENT_RENDER_LIMITS.maxElapsedMs,
      );
    }
  });
});
