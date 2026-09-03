import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Agent } from '@agent-bundle/runtime';
import { afterEach, beforeEach, describe, expect, it } from '@rstest/core';
import type { AgentEventRouteProps, CanonicalAgentEvent } from 'agent-bundle';
import { isValidElement, type ReactElement, type ReactNode } from 'react';

import StopRoute from '../src/events/stop.js';
import AfterToolRoute from '../src/events/tool/after.js';
import BeforeToolRoute from '../src/events/tool/before.js';

const fixturesDir = join(import.meta.dirname, 'fixtures', 'hooks');

const loadFixture = (name: string): Readonly<Record<string, unknown>> =>
  JSON.parse(readFileSync(join(fixturesDir, `${name}.json`), 'utf8')) as Readonly<Record<string, unknown>>;

const routeProps = (
  event: CanonicalAgentEvent,
  host: 'claude' | 'codex' | 'cursor',
  nativeEvent: string,
  native: Readonly<Record<string, unknown>>,
): AgentEventRouteProps => ({
  canonical: {
    event,
    idempotencyKey: 'k',
    observedAt: new Date().toISOString(),
    provenance: { host, hostContractRevision: 'test', nativeEvent, source: 'native' },
    sequence: 1,
  },
  native,
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
    const [before, after, stop] = await Promise.all([
      import('../src/events/tool/before.js'),
      import('../src/events/tool/after.js'),
      import('../src/events/stop.js'),
    ]);
    expect(before.config).toEqual({
      fallback: 'standalone',
      runtime: 'shared',
      targets: ['plugin'],
      timeoutMs: 10_000,
      tools: ['shell'],
    });
    expect(after.config).toEqual(before.config);
    expect(stop.config).toEqual({ runtime: 'standalone', targets: ['plugin'], timeoutMs: 900_000 });
  });

  it('tool/before rewrites a cargo shell command from a Claude envelope', async () => {
    const element = await BeforeToolRoute(
      routeProps('tool/before', 'claude', 'PreToolUse', loadFixture('claude-before-cargo')),
    );
    const decision = decisionOf(element);

    expect(decision.outcome).toBe('continue');
    expect(decision.reason).toBeUndefined();
    const command = decision.updatedInput?.command;
    expect(typeof command).toBe('string');
    expect(command).toContain('exec --session sess-claude');
    expect(command).toContain('--host claude');
    expect(command).toContain('-- cargo test -p foo');
    expect(contextOf(element)).toEqual([]);
  });

  it('tool/before leaves non-cargo commands untouched', async () => {
    const native = {
      ...loadFixture('claude-before-cargo'),
      tool_input: { command: 'ls -la' },
    };
    const element = await BeforeToolRoute(routeProps('tool/before', 'claude', 'PreToolUse', native));

    expect(decisionOf(element)).toEqual({ outcome: 'continue' });
    expect(contextOf(element)).toEqual([]);
  });

  it('tool/before attributes Cursor envelopes as host cursor', async () => {
    const element = await BeforeToolRoute(
      routeProps('tool/before', 'cursor', 'preToolUse', loadFixture('cursor-before-cargo')),
    );
    const decision = decisionOf(element);

    expect(decision.outcome).toBe('continue');
    expect(decision.updatedInput?.command).toContain('--host cursor');
    expect(decision.updatedInput?.command).toContain('--session sess-cursor');
  });

  it('tool/after accepts a Cursor envelope whose tool_output is a JSON string', async () => {
    const element = await AfterToolRoute(
      routeProps('tool/after', 'cursor', 'postToolUse', loadFixture('cursor-after-cargo')),
    );

    expect(decisionOf(element)).toEqual({ outcome: 'continue' });
    expect(contextOf(element)).toEqual([]);
  });

  it('tool/after accepts a Claude envelope with an object tool_response', async () => {
    const element = await AfterToolRoute(
      routeProps('tool/after', 'claude', 'PostToolUse', loadFixture('claude-after-cargo')),
    );

    expect(decisionOf(element)).toEqual({ outcome: 'continue' });
  });

  it('stop continues when the envelope carries no session', async () => {
    const element = await StopRoute(
      routeProps('stop', 'claude', 'Stop', { cwd: '/tmp/ws', stop_hook_active: false }),
    );

    expect(decisionOf(element)).toEqual({ outcome: 'continue' });
    expect(contextOf(element)).toEqual([]);
  });

  it('stop fails open when the daemon is unreachable', async () => {
    const element = await StopRoute(
      routeProps('stop', 'cursor', 'stop', { conversation_id: 'sess-cursor', loop_count: 1 }),
    );

    expect(decisionOf(element)).toEqual({ outcome: 'continue' });
  });
});
