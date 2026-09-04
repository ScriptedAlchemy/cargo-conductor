import { describe, expect, it } from 'effect-rstest';
import { expectDocument, renderRoute } from 'agent-bundle/test';
import type { AgentEventRouteProps, CanonicalAgentEvent } from 'agent-bundle';
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
  event: CanonicalAgentEvent,
  host: 'claude' | 'cursor',
  nativeEvent: string,
  native: Record<string, unknown>,
): Omit<AgentEventRouteProps, 'signal'> => ({
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
            .toContainContext('never kill cargo by PID');
          expect(rendered.document.value).toEqual({ outcome: 'continue' });
        }));
    }), 20_000);
});

/**
 * Permission semantics: the hauler never introduces a prompt. A rewritten
 * cargo command is governed by the daemon and returns an explicit `allow`
 * (since agent-bundle#461 a pass-through carries no decision, so `continue`
 * plus `updatedInput` would make the host prompt for the rewrite). Every
 * other shell call returns plain `continue` — no decision, the host's own
 * flow — never `allow` (that was the #461 blanket approval) and never `ask`.
 */
describe('tool/before cargo nudge', () => {
  it('allows a bare cargo command once it is rewritten onto the hauler exec path', async () => {
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
        outcome: 'allow',
        updatedInput: { command: expect.stringContaining('exec --session sess-2 --host claude') },
      });
      expect(rendered.document.value).toMatchObject({
        updatedInput: { command: expect.stringContaining('-- cargo check -p foo') },
      });
      expect(rendered.document.value).not.toHaveProperty('reason');
    });
  });

  it('allows the rewrite on Cursor too, attributed to host cursor', async () => {
    await withIsolatedStateDir(async () => {
      const rendered = await renderRoute('event:tool/before', {
        input: eventInput('tool/before', 'cursor', 'preToolUse', {
          conversation_id: 'conv-2',
          hook_event_name: 'preToolUse',
          tool_input: { command: 'cargo build' },
          tool_name: 'Shell',
        }),
      });
      expect(rendered.document.value).toMatchObject({
        outcome: 'allow',
        updatedInput: { command: expect.stringContaining('--session conv-2 --host cursor -- cargo build') },
      });
    });
  });

  it('rewrites but does not approve a cargo command beside an ungoverned segment', async () => {
    await withIsolatedStateDir(async () => {
      const rendered = await renderRoute('event:tool/before', {
        input: eventInput('tool/before', 'claude', 'PreToolUse', {
          hook_event_name: 'PreToolUse',
          session_id: 'sess-9',
          tool_input: { command: 'cargo test -p foo && rm -rf target' },
          tool_name: 'Bash',
        }),
      });
      // Brokered, but the host decides the whole rewritten command: `allow`
      // here would approve `rm -rf target` because cargo shares the input.
      expect(rendered.document.value).toMatchObject({
        outcome: 'continue',
        updatedInput: { command: expect.stringContaining('-- cargo test -p foo && rm -rf target') },
      });
      expect(rendered.document.value).not.toHaveProperty('reason');
    });
  });

  it('leaves non-cargo commands alone with no decision', async () => {
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

  it('makes no decision when the tool input carries no command', async () => {
    await withIsolatedStateDir(async () => {
      const rendered = await renderRoute('event:tool/before', {
        input: eventInput('tool/before', 'claude', 'PreToolUse', {
          hook_event_name: 'PreToolUse',
          session_id: 'sess-4',
          tool_input: { file_path: '/tmp/ws/Cargo.toml' },
          tool_name: 'Read',
        }),
      });
      expect(rendered.document.value).toEqual({ outcome: 'continue' });
    });
  });

  it('makes no decision for an already-brokered hauler exec it does not rewrite again', async () => {
    await withIsolatedStateDir(async () => {
      const rendered = await renderRoute('event:tool/before', {
        input: eventInput('tool/before', 'claude', 'PreToolUse', {
          hook_event_name: 'PreToolUse',
          session_id: 'sess-5',
          tool_input: { command: 'hauler exec --session sess-5 --host claude -- cargo check' },
          tool_name: 'Bash',
        }),
      });
      expect(rendered.document.value).toEqual({ outcome: 'continue' });
    });
  });

  it('makes no decision when the command cannot be parsed', async () => {
    await withIsolatedStateDir(async () => {
      const rendered = await renderRoute('event:tool/before', {
        input: eventInput('tool/before', 'claude', 'PreToolUse', {
          hook_event_name: 'PreToolUse',
          session_id: 'sess-7',
          tool_input: { command: 'cargo test &&' },
          tool_name: 'Bash',
        }),
      });
      expect(rendered.document.value).toEqual({ outcome: 'continue' });
    });
  });

  it('never prompts: tool/after and stop make no decision without a daemon hold', async () => {
    await withIsolatedStateDir(async () => {
      const after = await renderRoute('event:tool/after', {
        input: eventInput('tool/after', 'claude', 'PostToolUse', {
          cwd: '/tmp/ws',
          hook_event_name: 'PostToolUse',
          session_id: 'sess-8',
          tool_input: { command: 'cargo test -p foo' },
          tool_name: 'Bash',
          tool_response: { exit_code: 0, stdout: 'ok' },
        }),
      });
      expect(after.document.value).toEqual({ outcome: 'continue' });

      const stop = await renderRoute('event:stop', {
        input: eventInput('stop', 'claude', 'Stop', {
          cwd: '/tmp/ws',
          hook_event_name: 'Stop',
          session_id: 'sess-8',
          stop_hook_active: false,
        }),
      });
      expect(stop.document.value).toEqual({ outcome: 'continue' });
    });
  });

  it('runs cargo clean raw with no decision when no daemon is listening', async () => {
    await withIsolatedStateDir(async () => {
      const rendered = await renderRoute('event:tool/before', {
        input: eventInput('tool/before', 'claude', 'PreToolUse', {
          hook_event_name: 'PreToolUse',
          session_id: 'sess-6',
          tool_input: { command: 'cargo clean' },
          tool_name: 'Bash',
        }),
      });
      expect(rendered.document.value).toEqual({ outcome: 'continue' });
    });
  });
});
