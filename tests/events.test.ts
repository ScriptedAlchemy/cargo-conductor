import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Agent } from '@agent-bundle/runtime';
import { afterEach, beforeEach, describe, expect, it } from 'effect-rstest';
import type { AgentBundleConfig, AgentEventRouteProps, CanonicalAgentEvent } from 'agent-bundle';
import { createEventRouteInput } from 'agent-bundle/test';
import { isValidElement, type ReactElement, type ReactNode } from 'react';

import bundleConfig from '../agent-bundle.config.js';
import StopRoute from '../src/events/stop.js';
import { decisionValue } from '../src/lib/event-support.js';

/**
 * The props the generated wrapper hands a route: the host envelope validated,
 * frozen, and projected onto the family's canonical payload by the framework's
 * own table (agent-bundle#466), so a route reads `canonical.payload` here
 * exactly as it does in a host.
 */
const routeProps = <E extends CanonicalAgentEvent>(
  event: E,
  host: 'claude' | 'codex' | 'cursor',
  nativeEvent: string,
  native: Readonly<Record<string, unknown>>,
  options: { readonly validate?: boolean } = {},
): AgentEventRouteProps<E> => ({
  ...createEventRouteInput(event, native, { host, nativeEvent, ...options }),
  signal: new AbortController().signal,
});

interface DecisionValue {
  readonly outcome?: string;
  readonly reason?: string;
  readonly updatedInput?: Readonly<Record<string, unknown>>;
}

const decisionOf = (element: ReactElement): DecisionValue => {
  expect(element.type).toBe(Agent.Result);
  const props = element.props as { readonly value?: unknown };
  return (props.value ?? {}) as DecisionValue;
};

const collectContext = (node: ReactNode, into: string[] = []): string[] => {
  if (Array.isArray(node)) {
    for (const child of node) {
      collectContext(child, into);
    }
    return into;
  }
  if (!isValidElement(node)) {
    return into;
  }
  const props = node.props as { readonly children?: ReactNode };
  if (node.type === Agent.Context) {
    into.push(String(props.children));
    return into;
  }
  return collectContext(props.children, into);
};

const contextOf = (element: ReactElement): string[] =>
  collectContext((element.props as { readonly children?: ReactNode }).children);

describe('agent event routes', () => {
  const originalStateDir = process.env.CARGO_HAULER_STATE_DIR;
  const originalPluginRoot = process.env.AGENT_BUNDLE_PLUGIN_ROOT;

  beforeEach(() => {
    // Fresh state dir per test: no daemon socket (fail-open) and a clean
    // hook-events.jsonl / hook-state.json.
    process.env.CARGO_HAULER_STATE_DIR = mkdtempSync(join(tmpdir(), 'cargo-hauler-events-'));
    delete process.env.AGENT_BUNDLE_PLUGIN_ROOT;
  });

  afterEach(() => {
    if (originalStateDir === undefined) {
      delete process.env.CARGO_HAULER_STATE_DIR;
    } else {
      process.env.CARGO_HAULER_STATE_DIR = originalStateDir;
    }
    if (originalPluginRoot === undefined) {
      delete process.env.AGENT_BUNDLE_PLUGIN_ROOT;
    } else {
      process.env.AGENT_BUNDLE_PLUGIN_ROOT = originalPluginRoot;
    }
  });

  it('declares the expected static route configs', async () => {
    const [stop, sessionStart] = await Promise.all([
      import('../src/events/stop.js'),
      import('../src/events/session/start.js'),
    ]);
    const hosts = ['claude', 'codex', 'cursor'];
    expect(stop.config).toEqual({ runtime: 'standalone', targets: hosts, timeoutMs: 900_000 });
    expect(sessionStart.config).toEqual({ runtime: 'standalone', targets: hosts, timeoutMs: 5_000 });
  });

  it('declares the shell tool hooks as config handlers, not rendered routes', () => {
    // tool/before and tool/after are the two hooks every shell call pays for,
    // so they compile from `src/hooks/fast-path/` into standalone entries that
    // decide on the command before the rendering runtime loads (#90).
    expect(typeof bundleConfig).toBe('object');
    const config = bundleConfig as AgentBundleConfig;
    expect(config.hooks).toEqual({
      afterTool: { handler: './src/hooks/fast-path/shell-after.ts', timeout: 10, tools: ['shell'] },
      beforeTool: { handler: './src/hooks/fast-path/shell-before.ts', timeout: 10, tools: ['shell'] },
    });
  });

  it('decisionValue drops a reason from a continue result and keeps it on allow and deny', () => {
    // A pass-through carries no decision, so agent-bundle rejects `reason`
    // alongside `continue`; allow and deny keep theirs.
    expect(decisionValue({ outcome: 'continue', reason: 'ignored' })).toEqual({ outcome: 'continue' });
    expect(decisionValue({ outcome: 'allow', reason: 'brokered', updatedInput: { command: 'x' } })).toEqual({
      outcome: 'allow',
      reason: 'brokered',
      updatedInput: { command: 'x' },
    });
    expect(decisionValue({ outcome: 'deny', reason: 'blocked' })).toEqual({ outcome: 'deny', reason: 'blocked' });
  });

  it('stop continues when the envelope carries no session', async () => {
    // Deliberately partial: Claude always sends `session_id`, so the wrapper's
    // validation is bypassed to reach the route's own fail-open path.
    const element = await StopRoute(
      routeProps(
        'stop',
        'claude',
        'Stop',
        { cwd: '/tmp/ws', hook_event_name: 'Stop', stop_hook_active: false },
        { validate: false },
      ),
    );

    expect(decisionOf(element)).toEqual({ outcome: 'continue' });
    expect(contextOf(element)).toEqual([]);
  });

  it('stop fails open when the daemon is unreachable', async () => {
    const element = await StopRoute(
      routeProps('stop', 'cursor', 'stop', { conversation_id: 'sess-cursor', hook_event_name: 'stop', loop_count: 1 }),
    );

    expect(decisionOf(element)).toEqual({ outcome: 'continue' });
  });
});
