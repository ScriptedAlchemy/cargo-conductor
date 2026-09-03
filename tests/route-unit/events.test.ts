import { describe, expect, it } from 'effect-rstest';
import { expectDocument, renderRoute } from 'agent-bundle/test';
import * as Effect from 'effect/Effect';

import { scopedDaemon } from '../harness.js';

import { withIsolatedStateDir, withStateDir } from './support.js';

/**
 * Event routes are host protocol responses: no layout, a strict decision
 * value, and context as `Agent.Context` children. `session/start` is the one
 * route that reaches for the daemon itself (the provider skips the probe on
 * the event surface) and must never fail a session over a missing daemon.
 */

/** The `{ canonical, native }` props an event route receives, as the harness spells them. */
const eventInput = (
  event: 'session/start' | 'tool/before',
  host: 'claude' | 'cursor',
  nativeEvent: string,
  native: Record<string, unknown>,
) => ({
  canonical: {
    event,
    idempotencyKey: `route-unit-${event}-${host}`,
    observedAt: '2026-09-03T00:00:00.000Z',
    provenance: { host, hostContractRevision: 'route-unit', nativeEvent, source: 'native' },
    sequence: 1,
  },
  native,
});

describe('session/start daemon notice', () => {
  it('tells a new session the daemon is stopped and how it starts', async () => {
    await withIsolatedStateDir(async () => {
      const rendered = await renderRoute('event:session/start', {
        input: eventInput('session/start', 'claude', 'SessionStart', {
          hook_event_name: 'SessionStart',
          session_id: 'sess-1',
          source: 'startup',
        }),
      });
      expect(rendered.invocation.kind).toBe('event');
      expectDocument(rendered)
        .toHaveStatus('success')
        .toContainContext('cargo-hauler daemon stopped (no socket')
        .toContainContext('starts on demand');
      expect(rendered.document.value).toEqual({ outcome: 'continue' });
      // No shell around a protocol response.
      expect(JSON.stringify(rendered.document.root)).not.toContain('cargo-hauler · daemon');
    });
  });

  it.live('reports the running daemon with its lane summary and the no-kill rule', () =>
    Effect.gen(function* () {
      const fixture = yield* scopedDaemon(1);
      yield* Effect.promise(() =>
        withStateDir(fixture.config.stateDir, async () => {
          const rendered = await renderRoute('event:session/start', {
            input: eventInput('session/start', 'cursor', 'sessionStart', {
              conversation_id: 'conv-1',
              hook_event_name: 'sessionStart',
            }),
          });
          expectDocument(rendered)
            .toHaveStatus('success')
            .toContainContext('cargo-hauler daemon running (pid')
            .toContainContext('never kill in-flight cargo');
          expect(rendered.document.value).toEqual({ outcome: 'continue' });
        }));
    }), 20_000);
});

describe('tool/before cargo nudge', () => {
  it('rewrites a bare cargo command onto the hauler exec path', async () => {
    await withIsolatedStateDir(async () => {
      const rendered = await renderRoute('event:tool/before', {
        input: eventInput('tool/before', 'claude', 'PreToolUse', {
          cwd: '/tmp/ws',
          hook_event_name: 'PreToolUse',
          session_id: 'sess-2',
          tool_input: { command: 'cargo check -p foo' },
          tool_name: 'Bash',
        }),
      });
      expect(rendered.document.value).toMatchObject({
        outcome: 'continue',
        updatedInput: { command: expect.stringContaining('exec --session sess-2 --host claude') },
      });
      expect(rendered.document.value).toMatchObject({
        updatedInput: { command: expect.stringContaining('-- cargo check -p foo') },
      });
    });
  });

  it('leaves non-cargo commands alone', async () => {
    await withIsolatedStateDir(async () => {
      const rendered = await renderRoute('event:tool/before', {
        input: eventInput('tool/before', 'claude', 'PreToolUse', {
          hook_event_name: 'PreToolUse',
          session_id: 'sess-3',
          tool_input: { command: 'ls -la' },
          tool_name: 'Bash',
        }),
      });
      expect(rendered.document.value).toEqual({ outcome: 'continue' });
    });
  });
});
