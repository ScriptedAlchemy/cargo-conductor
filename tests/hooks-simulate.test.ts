import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { listHooks, simulateHook } from 'agent-bundle/api';
import { createEventRouteInput } from 'agent-bundle/test';
import { describe, expect, it } from 'effect-rstest';
import * as Effect from 'effect/Effect';

import { handleAfterShell } from '../src/hooks/after-shell.js';
import { handleBeforeShell, type HookContext } from '../src/hooks/before-shell.js';
import type { HookRecord } from '../src/hooks/record.js';
import { recordDeniedAttempt } from '../src/hooks/rpc.js';
import { shellEventFrom } from '../src/lib/event-support.js';

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

type FixtureHost = 'claude' | 'codex' | 'cursor';

/** The hook event the route would build: the envelope projected by the framework's own payload table. */
const shellEventOf = (event: 'tool/before' | 'tool/after', host: FixtureHost, native: Record<string, unknown>) =>
  shellEventFrom(createEventRouteInput(event, native, { host }).canonical.payload);

const runWrapper = (
  wrapper: string,
  input: Record<string, unknown>,
  stateDir = join(repoRoot, '.tmp-hook-simulate'),
): Promise<{ readonly code: number; readonly stderr: string; readonly stdout: string }> =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [wrapper], {
      cwd: artifactRoot,
      env: {
        ...process.env,
        AGENT_BUNDLE_HOOK_HOST: 'claude',
        CARGO_HAULER_STATE_DIR: stateDir,
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

/**
 * The compiled shell hook entry for one host pack: the config-declared
 * `beforeTool`/`afterTool` handler from `src/hooks/fast-path/`, emitted as
 * `before-tool-shell-before-<hash>.mjs` next to the event-route wrappers.
 */
const findHookEntry = (event: 'before-tool' | 'after-tool', host: 'claude' | 'cursor'): string | undefined => {
  const root = host === 'cursor' ? cursorHooksRoot : claudeHooksRoot;
  if (!existsSync(root)) {
    return undefined;
  }
  const found = readdirSync(root).find((name) => name.startsWith(`${event}-`) && name.endsWith('.mjs'));
  return found === undefined ? undefined : join(root, found);
};

/** The canonical `HookEvent` a config-declared hook receives; `simulateHook` encodes it to the host envelope itself. */
const canonicalShellEvent = (command: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  cwd: '/tmp/ws',
  sessionId: 'sess-claude',
  toolInput: { command },
  toolName: 'Bash',
  toolUseId: 'toolu_simulate',
  transcriptPath: '/tmp/transcript.json',
  ...extra,
});

const claudeEnvelope = (
  hookEventName: 'PreToolUse' | 'PostToolUse',
  command: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  cwd: '/tmp/ws',
  hook_event_name: hookEventName,
  session_id: 'sess-claude',
  tool_input: { command },
  tool_name: 'Bash',
  tool_use_id: 'toolu_native',
  transcript_path: '/tmp/transcript.json',
  ...extra,
});

describe('host envelope fixtures', () => {
  it('rewrites cargo from Claude, Codex, and Cursor native beforeTool envelopes', async () => {
    const cases: readonly { readonly file: string; readonly context: HookContext; readonly host: FixtureHost }[] = [
      { context: { nativeEvent: 'PreToolUse', target: 'claude' }, file: 'claude-before-cargo.json', host: 'claude' },
      { context: { nativeEvent: 'PreToolUse', target: 'codex' }, file: 'codex-before-cargo.json', host: 'codex' },
      { context: { nativeEvent: 'preToolUse', target: 'cursor' }, file: 'cursor-before-cargo.json', host: 'cursor' },
    ];

    for (const item of cases) {
      const result = await handleBeforeShell(
        shellEventOf('tool/before', item.host, loadJson(item.file)),
        item.context,
        services,
      );
      expect(result.outcome).toBe('allow');
      expect(result.updatedInput?.command).toContain(`--host ${item.host}`);
      expect(result.updatedInput?.command).toContain('-- cargo');
    }
  });

  it('records afterTool from Claude and Cursor native envelopes', async () => {
    const records: HookRecord[] = [];
    const cases: readonly { readonly context: HookContext; readonly file: string; readonly host: FixtureHost }[] = [
      { context: { nativeEvent: 'PostToolUse', target: 'claude' }, file: 'claude-after-cargo.json', host: 'claude' },
      { context: { nativeEvent: 'postToolUse', target: 'cursor' }, file: 'cursor-after-cargo.json', host: 'cursor' },
    ];

    for (const item of cases) {
      // Claude's `tool_response` object and Cursor's `tool_output` JSON string
      // arrive as one canonical `toolResponse` (agent-bundle#466).
      await handleAfterShell(shellEventOf('tool/after', item.host, loadJson(item.file)), item.context, {
        record: (entry) => {
          records.push(entry);
        },
      });
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
          // Config-declared hooks are simulated with the canonical event; the
          // wrapper encodes it to Claude's envelope before the handler runs.
          input: canonicalShellEvent('cargo test -p foo'),
          root: repoRoot,
          target: 'claude',
        });
        // `allow` is the one decision the handler contract cannot carry, so
        // the hook writes Claude's native PreToolUse output itself — which is
        // also what the simulation reads back here.
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
          input: canonicalShellEvent('cargo test -p foo', { toolResponse: { exit_code: 0, stdout: 'ok' } }),
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

  it.skipIf(findHookEntry('before-tool', 'claude') === undefined)(
    'accepts native Claude and Codex PreToolUse envelopes on the compiled entry',
    async () => {
      const entry = findHookEntry('before-tool', 'claude')!;
      for (const file of ['claude-before-cargo.json', 'codex-before-cargo.json'] as const) {
        const ran = await runWrapper(entry, loadJson(file));
        expect(ran.stderr).toBe('');
        expect(ran.code).toBe(0);
        expect(ran.stdout.length).toBeGreaterThan(0);
        const output = JSON.parse(ran.stdout) as {
          readonly hookSpecificOutput?: {
            readonly permissionDecision?: string;
            readonly updatedInput?: { readonly command?: string };
          };
        };
        expect(output.hookSpecificOutput?.permissionDecision).toBe('allow');
        expect(output.hookSpecificOutput?.updatedInput?.command).toContain('exec --session');
        expect(output.hookSpecificOutput?.updatedInput?.command).toContain('-- cargo');
      }
    },
  );

  it.skipIf(findHookEntry('before-tool', 'cursor') === undefined)(
    'accepts a native Cursor preToolUse envelope on the compiled cursor entry',
    async () => {
      const entry = findHookEntry('before-tool', 'cursor')!;
      const ran = await runWrapper(entry, loadJson('cursor-before-cargo.json'));
      expect(ran.stderr).toBe('');
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

  it.skipIf(findHookEntry('before-tool', 'claude') === undefined || findHookEntry('after-tool', 'claude') === undefined)(
    'answers a non-cargo shell call on both entries with no output, no daemon, and no state (#90)',
    async () => {
      const stateDir = mkdtempSync(join(tmpdir(), 'hauler-fast-path-'));
      try {
        const before = await runWrapper(findHookEntry('before-tool', 'claude')!, claudeEnvelope('PreToolUse', 'ls -la'), stateDir);
        expect(before).toEqual({ code: 0, stderr: '', stdout: '' });
        const after = await runWrapper(
          findHookEntry('after-tool', 'claude')!,
          claudeEnvelope('PostToolUse', 'ls -la', { tool_response: { exit_code: 0, stdout: 'ok' } }),
          stateDir,
        );
        // No daemon socket in this state dir: the completion ping fails open
        // and quietly, and nothing was recorded or advanced.
        expect(after).toEqual({ code: 0, stderr: '', stdout: '' });
        expect(readdirSync(stateDir)).toEqual([]);
      } finally {
        rmSync(stateDir, { force: true, recursive: true });
      }
    },
  );

  it.skipIf(!existsSync(claudeHooksRoot))('ships the shell hook entries without the rendering runtime', () => {
    for (const host of ['claude', 'cursor'] as const) {
      for (const event of ['before-tool', 'after-tool'] as const) {
        const entry = findHookEntry(event, host);
        expect(entry).toBeDefined();
        const source = readFileSync(entry!, 'utf8');
        // The whole entry — token test, socket ping, and the deferred
        // rewrite/telemetry chunk — stays a fraction of the 3.6 MB event
        // wrapper, and never pulls in React or the Flight worker.
        expect(statSync(entry!).size).toBeLessThan(512 * 1024);
        expect(source).not.toContain('react-dom');
        expect(source).not.toContain('hooks-flight');
        expect(source).not.toContain('event-ipc');
      }
    }
  });
});
