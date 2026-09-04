import { describe, expect, it } from 'effect-rstest';

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
  haulerArgv: ['hauler'],
  probeDaemon: () => 'idle',
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
  it('rewrites a cargo command to hauler exec with session and host', async () => {
    const result = await runBefore('cargo test -p foo');

    expect(result.outcome).toBe('allow');
    expect(result.updatedInput).toEqual({
      command: 'hauler exec --session sess-1 --host claude -- cargo test -p foo',
      timeout: 120,
    });
    expect(result.reason).toBeUndefined();
  });

  it('keeps env-prefix assignments on the rewritten hauler invocation', async () => {
    const result = await runBefore('CARGO_TARGET_DIR=tmp cargo test');

    expect(result.updatedInput?.command).toBe(
      'CARGO_TARGET_DIR=tmp hauler exec --session sess-1 --host claude -- cargo test',
    );
  });

  it('rewrites each cargo in a list and leaves the pipeline consumer in place', async () => {
    const result = await runBefore('cargo check && cargo test | tee log.txt');

    expect(result.updatedInput?.command).toBe(
      'hauler exec --session sess-1 --host claude -- cargo check && hauler exec --session sess-1 --host claude -- cargo test | tee log.txt',
    );
  });

  it('rewrites cargo after sudo/env prefixes without moving the prefix', async () => {
    const result = await runBefore('sudo -u builder cargo test');

    expect(result.updatedInput?.command).toBe(
      'sudo -u builder hauler exec --session sess-1 --host claude -- cargo test',
    );
  });

  it('rewrites the escape hatches agents reach for: env -u, timeout, rustup run, toolchain paths', async () => {
    const wrap = 'hauler exec --session sess-1 --host claude --';
    const toolchain = '/home/me/.rustup/toolchains/stable-x86_64-unknown-linux-gnu/bin/cargo';

    // `env` operands after flags: unsets, then an assignment, then cargo.
    const unset = await runBefore(`env -u CARGO_HAULER_STATE_DIR -u FOO RUSTC=/x/rustc ${toolchain} check -p a`);
    expect(unset.updatedInput?.command).toBe(
      `env -u CARGO_HAULER_STATE_DIR -u FOO RUSTC=/x/rustc ${wrap} ${toolchain} check -p a`,
    );

    const timed = await runBefore('timeout -k 10 600 cargo test -p a 2>&1 | tail -20');
    expect(timed.updatedInput?.command).toBe(`timeout -k 10 600 ${wrap} cargo test -p a 2>&1 | tail -20`);

    const viaRustup = await runBefore('rustup run nightly cargo check');
    expect(viaRustup.updatedInput?.command).toBe(`rustup run nightly ${wrap} cargo check`);

    // Other rustup subcommands are not cargo invocations.
    const rustupOnly = await runBefore('rustup toolchain list');
    expect(rustupOnly.updatedInput).toBeUndefined();

    const buffered = await runBefore('stdbuf -oL cargo build');
    expect(buffered.updatedInput?.command).toBe(`stdbuf -oL ${wrap} cargo build`);
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

  it('does not rewrite an already-brokered hauler exec', async () => {
    const command = 'hauler exec --session sess-1 --host claude -- cargo test';
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
      probeDaemon: () => 'active',
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

    expect(result.outcome).toBe('allow');
    expect(result.updatedInput?.command).toContain('hauler exec');
    expect(result.updatedInput?.command).toContain('-- cargo +nightly clean -p foo');
  });

  it('runs cargo clean raw when no daemon is listening', async () => {
    const result = await runBefore('cargo clean', undefined, {
      probeDaemon: () => 'absent',
    });

    expect(result).toEqual({ outcome: 'continue' });
  });

  it('brokers cargo clean when the daemon is too busy to answer the probe', async () => {
    // A saturated daemon is exactly when a raw clean would race in-flight
    // builds; the lane serializes it instead.
    const result = await runBefore('cargo clean -p foo', undefined, {
      probeDaemon: () => 'busy',
    });

    expect(result.outcome).toBe('allow');
    expect(result.updatedInput?.command).toBe('hauler exec --session sess-1 --host claude -- cargo clean -p foo');
  });

  it('runs cargo clean raw when the probe itself throws', async () => {
    const result = await runBefore('cargo clean', undefined, {
      probeDaemon: () => {
        throw new Error('boom');
      },
    });

    expect(result).toEqual({ outcome: 'continue' });
  });

  it('does not consult the daemon probe for non-destructive cargo', async () => {
    const result = await runBefore('cargo test', undefined, {
      haulerArgv: ['hauler'],
      probeDaemon: () => {
        throw new Error('boom');
      },
    });

    expect(result.outcome).toBe('allow');
    expect(result.updatedInput?.command).toContain('hauler exec');
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
