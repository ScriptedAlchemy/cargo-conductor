import { describe, expect, it } from '@rstest/core';

import { handleAfterShell, type AfterShellEvent } from '../src/hooks/after-shell.js';
import {
  handleBeforeShell,
  type BeforeShellEvent,
  type HookContext,
  type HookServices,
} from '../src/hooks/before-shell.js';
import type { HookRecord } from '../src/hooks/record.js';

const services = (
  extras: HookServices = {},
): HookServices => ({
  conductorArgv: ['conductor'],
  hasActiveBuilds: () => false,
  ...extras,
});

const beforeEvent = (command: string, extras: Partial<BeforeShellEvent> = {}): BeforeShellEvent => ({
  cwd: '/tmp/ws',
  sessionId: 'sess-1',
  toolInput: { command, timeout: 120 },
  toolName: 'Bash',
  toolUseId: 'toolu_1',
  ...extras,
});

const runBefore = async (
  command: string,
  context: HookContext = { nativeEvent: 'PreToolUse', target: 'claude' },
  extras: HookServices = {},
) => handleBeforeShell(beforeEvent(command), context, services(extras));

describe('beforeTool shell hook', () => {
  it('rewrites a cargo command to conductor exec with session and host', async () => {
    const result = await runBefore('cargo test -p foo');

    expect(result.outcome).toBe('continue');
    expect(result.updatedInput).toEqual({
      command: 'conductor exec --session sess-1 --host claude --cwd /tmp/ws -- cargo test -p foo',
      timeout: 120,
    });
    expect(result.reason).toBeUndefined();
  });

  it('keeps env-prefix assignments on the rewritten conductor invocation', async () => {
    const result = await runBefore('CARGO_TARGET_DIR=tmp cargo test');

    expect(result.updatedInput?.command).toBe(
      'CARGO_TARGET_DIR=tmp conductor exec --session sess-1 --host claude --cwd /tmp/ws -- cargo test',
    );
  });

  it('rewrites each cargo in a list and leaves the pipeline consumer in place', async () => {
    const result = await runBefore('cargo check && cargo test | tee log.txt');

    expect(result.updatedInput?.command).toBe(
      'conductor exec --session sess-1 --host claude --cwd /tmp/ws -- cargo check && conductor exec --session sess-1 --host claude --cwd /tmp/ws -- cargo test | tee log.txt',
    );
  });

  it('rewrites cargo after sudo/env prefixes without moving the prefix', async () => {
    const result = await runBefore('sudo -u builder cargo test');

    expect(result.updatedInput?.command).toBe(
      'sudo -u builder conductor exec --session sess-1 --host claude --cwd /tmp/ws -- cargo test',
    );
  });

  it('attributes Cursor envelopes as host cursor', async () => {
    const result = await handleBeforeShell(
      beforeEvent('cargo check'),
      { nativeEvent: 'preToolUse', target: 'plugin' },
      services(),
    );

    expect(result.updatedInput?.command).toContain('--host cursor');
  });

  it('does not rewrite non-cargo commands', async () => {
    const result = await runBefore('ls -la');

    expect(result).toEqual({ outcome: 'continue' });
  });

  it('does not rewrite an already-brokered conductor exec', async () => {
    const command = 'conductor exec --session sess-1 --host claude -- cargo test';
    const result = await runBefore(command);

    expect(result).toEqual({ outcome: 'continue' });
  });

  it('fails open when bashjsast cannot parse the command', async () => {
    const result = await runBefore('cargo test &&');

    expect(result).toEqual({ outcome: 'continue' });
  });

  it('fails open when the command field is missing', async () => {
    const result = await handleBeforeShell(
      { toolInput: { path: 'Cargo.toml' }, toolName: 'Read' },
      { target: 'claude' },
      services(),
    );

    expect(result).toEqual({ outcome: 'continue' });
  });

  it('denies cargo clean while builds are active and never rewrites on deny', async () => {
    const records: HookRecord[] = [];
    const result = await runBefore('cargo clean', undefined, {
      hasActiveBuilds: () => true,
      record: (entry) => {
        records.push(entry);
      },
    });

    expect(result.outcome).toBe('deny');
    expect(result.reason).toMatch(/cargo clean/u);
    expect(result.updatedInput).toBeUndefined();
    expect(records.some((entry) => entry.outcome === 'deny')).toBe(true);
  });

  it('rewrites cargo clean when the daemon is idle', async () => {
    const result = await runBefore('cargo +nightly clean -p foo');

    expect(result.outcome).toBe('continue');
    expect(result.updatedInput?.command).toContain('conductor exec');
    expect(result.updatedInput?.command).toContain('-- cargo +nightly clean -p foo');
  });

  it('fails open on cargo clean when the daemon is unreachable', async () => {
    const result = await runBefore('cargo clean', undefined, {
      hasActiveBuilds: () => null,
    });

    expect(result).toEqual({ outcome: 'continue' });
  });

  it('does not consult the daemon probe for non-destructive cargo', async () => {
    const result = await runBefore('cargo test', undefined, {
      conductorArgv: ['conductor'],
      hasActiveBuilds: () => {
        throw new Error('boom');
      },
    });

    expect(result.outcome).toBe('continue');
    expect(result.updatedInput?.command).toContain('conductor exec');
  });
});

describe('afterTool recorder', () => {
  it('records the completed shell command and cannot deny or replace input', async () => {
    const records: HookRecord[] = [];
    const event: AfterShellEvent = {
      cwd: '/tmp/ws',
      sessionId: 'sess-1',
      toolInput: { command: 'cargo test -p foo' },
      toolName: 'Bash',
      toolResponse: { exitCode: 0, interrupted: false },
    };

    const result = await handleAfterShell(
      event,
      { nativeEvent: 'PostToolUse', target: 'claude' },
      {
        record: (entry) => {
          records.push(entry);
        },
      },
    );

    expect(result).toEqual({ outcome: 'continue' });
    expect(records).toEqual([
      expect.objectContaining({
        command: 'cargo test -p foo',
        cwd: '/tmp/ws',
        exitCode: 0,
        host: 'claude',
        outcome: 'continue',
        phase: 'afterTool',
        session: 'sess-1',
      }),
    ]);
  });

  it('fails open when the recorder throws', async () => {
    const result = await handleAfterShell(
      {
        toolInput: { command: 'cargo test' },
        toolName: 'Bash',
      },
      { target: 'claude' },
      {
        record: () => {
          throw new Error('disk full');
        },
      },
    );

    expect(result).toEqual({ outcome: 'continue' });
  });
});
