import { describe, expect, it } from 'effect-rstest';
import { createEventRouteInput, expectDocument, renderRoute } from 'agent-bundle/test';
import type { CanonicalAgentEvent } from 'agent-bundle';
import * as Effect from 'effect/Effect';

import { scopedDaemon } from '../harness.js';

import { withIsolatedStateDir, withStateDir } from './support.js';

/**
 * Event routes are host protocol responses: no layout, a strict decision
 * value, and context as `Agent.Context` children. `session/start` is the one
 * route that reaches for the daemon itself (the provider skips the probe on
 * the event surface) and must never fail a session over a missing daemon.
 */

/** The envelope fields every host sends on every hook (and every tool hook), beside what a case names. */
const baseEnvelope = (event: CanonicalAgentEvent): Record<string, unknown> => ({
  cwd: '/tmp/ws',
  transcript_path: '/tmp/transcript.json',
  ...(event.startsWith('tool/') ? { tool_use_id: 'toolu_route_unit' } : {}),
});

/**
 * The `{ canonical, native }` props an event route receives: the envelope
 * validated and projected onto the family's canonical payload exactly as the
 * generated wrapper does it (agent-bundle#466).
 */
const eventInput = <E extends CanonicalAgentEvent>(
  event: E,
  host: 'claude' | 'cursor',
  nativeEvent: string,
  native: Record<string, unknown>,
) => createEventRouteInput(event, { ...baseEnvelope(event), ...native }, { host, nativeEvent });

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
            .toContainContext('never kill cargo by PID');
          expect(rendered.document.value).toEqual({ outcome: 'continue' });
        }));
    }), 20_000);
});

/**
 * Permission semantics: the hauler never introduces a prompt. The shell tool
 * hooks (tool/before, tool/after) are config-declared handlers rather than
 * rendered routes since #90, so their decisions — `allow` for a rewritten
 * cargo command, `continue` plus `updatedInput` beside an ungoverned segment,
 * plain `continue` for everything else, never `ask` — are proven in
 * `tests/hook-fast-path.test.ts` against the handler and in
 * `tests/hooks-simulate.test.ts` against the compiled entries. The stop route
 * stays here: it makes no decision without a daemon hold.
 */
describe('stop route', () => {
  it('never prompts: stop makes no decision without a daemon hold', async () => {
    await withIsolatedStateDir(async () => {
      const stop = await renderRoute('event:stop', {
        input: eventInput('stop', 'claude', 'Stop', {
          cwd: '/tmp/ws',
          hook_event_name: 'Stop',
          last_assistant_message: 'done',
          session_id: 'sess-8',
          stop_hook_active: false,
        }),
      });
      expect(stop.document.value).toEqual({ outcome: 'continue' });
    });
  });
});
