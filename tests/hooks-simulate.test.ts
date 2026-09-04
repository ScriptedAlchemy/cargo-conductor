import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { listHooks, simulateHook } from 'agent-bundle/api';
import { describe, expect, it } from 'effect-rstest';
import * as Effect from 'effect/Effect';

import { handleAfterShell } from '../src/hooks/after-shell.js';
import {
  handleBeforeShell,
  type BeforeShellEvent,
  type HookContext,
} from '../src/hooks/before-shell.js';
import type { HookRecord } from '../src/hooks/record.js';
import { recordDeniedAttempt } from '../src/hooks/rpc.js';

import { pollReport, scopedDaemon } from './harness.js';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const fixtureRoot = join(repoRoot, 'tests', 'fixtures', 'hooks');
const artifactRoot = join(repoRoot, 'artifact');
const claudeHooksRoot = join(artifactRoot, 'claude', 'hooks');
const cursorHooksRoot = join(artifactRoot, 'cursor', 'hooks');

const loadJson = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(fixtureRoot, name), 'utf8')) as Record<string, unknown>;

const services = {
  haulerArgv: ['hauler'] as const,
  probeDaemon: () => 'idle' as const,
};

const canonicalFromNative = (native: Record<string, unknown>): BeforeShellEvent => ({
  cwd: typeof native.cwd === 'string' ? native.cwd : undefined,
  sessionId:
    typeof native.session_id === 'string'
      ? native.session_id
      : typeof native.conversation_id === 'string'
        ? native.conversation_id
        : undefined,
  toolInput: native.tool_input as Readonly<Record<string, unknown>> | undefined,
  toolName: typeof native.tool_name === 'string' ? native.tool_name : undefined,
  toolUseId: typeof native.tool_use_id === 'string' ? native.tool_use_id : undefined,
});

const runWrapper = (
  wrapper: string,
  input: Record<string, unknown>,
): Promise<{ readonly code: number; readonly stderr: string; readonly stdout: string }> =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [wrapper], {
      cwd: artifactRoot,
      env: {
        ...process.env,
        AGENT_BUNDLE_HOOK_HOST: 'claude',
        CARGO_HAULER_STATE_DIR: join(repoRoot, '.tmp-hook-simulate'),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code: code ?? 1, stderr, stdout });
    });
    child.stdin.end(`${JSON.stringify(input)}\n`);
  });

/** The generated event-route wrapper for one hook in one host pack (`event-route-tool-before.mjs`). */
const findWrapper = (event: 'tool-before' | 'tool-after', host: 'claude' | 'cursor'): string | undefined => {
  const root = host === 'cursor' ? cursorHooksRoot : claudeHooksRoot;
  if (!existsSync(root)) {
    return undefined;
  }
  const expected = `event-route-${event}.mjs`;
  const found = readdirSync(root).find((name) => name === expected);
  return found === undefined ? undefined : join(root, found);
};

describe('host envelope fixtures', () => {
  it('rewrites cargo from Claude, Codex, and Cursor native beforeTool envelopes', async () => {
    const cases: readonly { readonly file: string; readonly context: HookContext; readonly host: string }[] = [
      { context: { nativeEvent: 'PreToolUse', target: 'claude' }, file: 'claude-before-cargo.json', host: 'claude' },
      { context: { nativeEvent: 'PreToolUse', target: 'codex' }, file: 'codex-before-cargo.json', host: 'codex' },
      { context: { nativeEvent: 'preToolUse', target: 'cursor' }, file: 'cursor-before-cargo.json', host: 'cursor' },
    ];

    for (const item of cases) {
      const result = await handleBeforeShell(canonicalFromNative(loadJson(item.file)), item.context, services);
      expect(result.outcome).toBe('continue');
      expect(result.updatedInput?.command).toContain(`--host ${item.host}`);
      expect(result.updatedInput?.command).toContain('-- cargo');
    }
  });

  it('records afterTool from Claude and Cursor native envelopes', async () => {
    const records: HookRecord[] = [];
    const cases: readonly { readonly context: HookContext; readonly file: string }[] = [
      { context: { nativeEvent: 'PostToolUse', target: 'claude' }, file: 'claude-after-cargo.json' },
      { context: { nativeEvent: 'postToolUse', target: 'cursor' }, file: 'cursor-after-cargo.json' },
    ];

    for (const item of cases) {
      const native = loadJson(item.file);
      const toolResponse =
        native.tool_response ??
        (typeof native.tool_output === 'string' ? JSON.parse(native.tool_output) : undefined);
      await handleAfterShell(
        { ...canonicalFromNative(native), toolResponse },
        item.context,
        {
          record: (entry) => {
            records.push(entry);
          },
        },
      );
    }

    expect(records).toEqual([
      expect.objectContaining({ host: 'claude', phase: 'afterTool', session: 'sess-claude' }),
      expect.objectContaining({ host: 'cursor', phase: 'afterTool', session: 'sess-cursor' }),
    ]);
  });

  it.live('records a denied destructive hook attempt in the daemon ledger', () =>
    Effect.gen(function* () {
      const fixture = yield* scopedDaemon(1);
      const result = yield* Effect.promise(() =>
        handleBeforeShell(
          {
            cwd: fixture.ws1,
            sessionId: 'deny-session',
            toolInput: { command: 'cargo clean' },
            toolName: 'Bash',
          },
          { nativeEvent: 'preToolUse', target: 'cursor' },
          {
            probeDaemon: () => 'active',
            record: () => undefined,
            recordAttempt: (attempt) =>
              recordDeniedAttempt(attempt, fixture.config.socketPath),
          },
        ),
      );
      expect(result).toEqual(
        expect.objectContaining({
          outcome: 'deny',
          reason: expect.stringContaining('cargo clean is blocked'),
        }),
      );

      const report = yield* pollReport(fixture, (candidate) =>
        candidate.recent.some((request) => request.status === 'denied'),
      );
      expect(report.recent).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            argv: ['cargo', 'clean'],
            cwd: fixture.ws1,
            error: expect.stringContaining('cargo clean is blocked'),
            host: 'cursor',
            session: 'deny-session',
            status: 'denied',
          }),
        ]),
      );
    }));
});

describe('agent-bundle hooks simulate', () => {
  it.skipIf(!existsSync(join(artifactRoot, 'agent-bundle.hooks.json')))(
    'simulates the Claude beforeTool, afterTool, and stop wrappers',
    async () => {
      const previousHost = process.env.AGENT_BUNDLE_HOOK_HOST;
      const previousState = process.env.CARGO_HAULER_STATE_DIR;
      process.env.AGENT_BUNDLE_HOOK_HOST = 'claude';
      process.env.CARGO_HAULER_STATE_DIR = join(repoRoot, '.tmp-hook-simulate');
      try {
        const hooks = await listHooks({ artifact: artifactRoot, root: repoRoot, target: 'claude' });
        const before = hooks.find((hook) => hook.event === 'beforeTool');
        const after = hooks.find((hook) => hook.event === 'afterTool');
        const stop = hooks.find((hook) => hook.event === 'stop');
        expect(before).toBeDefined();
        expect(after).toBeDefined();
        expect(stop).toBeDefined();
        expect(stop?.timeout).toBe(900);

        const rewritten = await simulateHook({
          artifact: artifactRoot,
          hook: before!.name,
          // Event routes receive the host-native envelope, never the canonical one.
          input: loadJson('claude-before-cargo.json'),
          root: repoRoot,
          target: 'claude',
        });
        // The generated wrapper projects the route decision onto Claude's
        // native PreToolUse output.
        expect(rewritten).toEqual({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'allow',
            updatedInput: {
              command: expect.stringContaining('exec --session sess-claude --host claude'),
            },
          },
        });

        const recorded = await simulateHook({
          artifact: artifactRoot,
          hook: after!.name,
          input: loadJson('claude-after-cargo.json'),
          root: repoRoot,
          target: 'claude',
        });
        // afterTool without additionalContext encodes to empty host output.
        expect(recorded).toBeUndefined();
        const events = readFileSync(
          join(repoRoot, '.tmp-hook-simulate', 'hook-events.jsonl'),
          'utf8',
        );
        expect(events).toContain('"phase":"afterTool"');
        expect(events).toContain('cargo test -p foo');

        const stopped = await simulateHook({
          artifact: artifactRoot,
          hook: stop!.name,
          input: {
            cwd: '/tmp/ws',
            hook_event_name: 'Stop',
            last_assistant_message: 'stopping',
            session_id: 'sess-claude',
            stop_hook_active: false,
            transcript_path: '/tmp/transcript.json',
          },
          root: repoRoot,
          target: 'claude',
        });
        // Daemon is down: stop-hold fails open. Continue without extra
        // context encodes to empty host output (same as afterTool).
        expect(stopped).toBeUndefined();
      } finally {
        if (previousHost === undefined) {
          delete process.env.AGENT_BUNDLE_HOOK_HOST;
        } else {
          process.env.AGENT_BUNDLE_HOOK_HOST = previousHost;
        }
        if (previousState === undefined) {
          delete process.env.CARGO_HAULER_STATE_DIR;
        } else {
          process.env.CARGO_HAULER_STATE_DIR = previousState;
        }
        rmSync(join(repoRoot, '.tmp-hook-simulate'), { force: true, recursive: true });
      }
    },
    // Each simulateHook call re-prepares the project (~7 s); the wrappers
    // themselves answer in well under a second.
    90_000,
  );

  it.skipIf(findWrapper('tool-before', 'claude') === undefined)(
    'accepts native Claude and Codex PreToolUse envelopes on the generated wrapper',
    async () => {
      const wrapper = findWrapper('tool-before', 'claude')!;
      for (const file of ['claude-before-cargo.json', 'codex-before-cargo.json'] as const) {
        const ran = await runWrapper(wrapper, loadJson(file));
        expect(ran.code).toBe(0);
        expect(ran.stdout.length).toBeGreaterThan(0);
        const output = JSON.parse(ran.stdout) as {
          readonly hookSpecificOutput?: { readonly updatedInput?: { readonly command?: string } };
        };
        expect(output.hookSpecificOutput?.updatedInput?.command).toContain('exec --session');
        expect(output.hookSpecificOutput?.updatedInput?.command).toContain('-- cargo');
      }
    },
  );

  it.skipIf(findWrapper('tool-before', 'cursor') === undefined)(
    'accepts a native Cursor preToolUse envelope on the generated cursor wrapper',
    async () => {
      const wrapper = findWrapper('tool-before', 'cursor')!;
      const ran = await runWrapper(wrapper, loadJson('cursor-before-cargo.json'));
      expect(ran.code).toBe(0);
      expect(ran.stdout.length).toBeGreaterThan(0);
      const output = JSON.parse(ran.stdout) as {
        readonly permission?: string;
        readonly updated_input?: { readonly command?: string };
      };
      expect(output.permission).toBe('allow');
      expect(output.updated_input?.command).toContain('--host cursor');
      expect(output.updated_input?.command).toContain('-- cargo test -p foo');
    },
  );
});
