import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from '@rstest/core';
import * as Effect from 'effect/Effect';

import { runCli, type HaulerOperations, warnRemovedLegacyStateDir } from '../src/cli.js';
import type { RunExecOptions, RunExecResult } from '../src/client/exec.js';

const stoppedSnapshot = {
  active: [] as const,
  daemon: 'stopped' as const,
  lanes: [] as const,
  maxConcurrent: null,
  pid: null,
  recent: [] as const,
  socketPath: '/tmp/cc/daemon.sock',
  startedAtMs: null,
  stateRoot: '/tmp/cc',
  summary: 'cargo-hauler daemon is not running',
};

const operations = (): HaulerOperations => ({
  await: async (input) => ({
    operation: 'await',
    request: null,
    summary: `${input.ticket} not found`,
    ticket: input.ticket,
    timedOut: false,
  }),
  daemon: async (input) => ({
    message: input.subcommand === 'status' ? 'cargo-hauler daemon is not running' : `${input.subcommand} ok`,
    operation: 'daemon',
    pid: null,
    report: null,
    running: false,
    socketPath: '/tmp/cc/daemon.sock',
    subcommand: input.subcommand,
  }),
  last: async () => ({
    daemon: 'stopped',
    operation: 'last',
    request: null,
    summary: 'no hauler requests recorded',
  }),
  log: async () => ({
    daemon: 'stopped',
    operation: 'log',
    requests: [],
    summary: 'no hauler requests recorded',
  }),
  request: async () => ({
    operation: 'request',
    summary: 'cc-1 submitted',
    ticket: 'cc-1',
  }),
  result: async (input) => ({
    operation: 'result',
    request: null,
    summary: `${input.ticket} not found`,
    ticket: input.ticket,
  }),
  status: async () => ({
    ...stoppedSnapshot,
    operation: 'status',
  }),
});

const run = async (
  argv: readonly string[],
  extras: {
    readonly operations?: HaulerOperations;
    readonly runExec?: (options: RunExecOptions) => Effect.Effect<RunExecResult>;
    readonly signal?: AbortSignal;
  } = {},
): Promise<{ readonly code: number; readonly text: string }> => {
  const lines: string[] = [];
  const code = await runCli(argv, {
    ...(extras.operations === undefined ? {} : { operations: extras.operations }),
    ...(extras.runExec === undefined ? {} : { runExec: extras.runExec }),
    ...(extras.signal === undefined ? {} : { signal: extras.signal }),
    write: (line) => lines.push(line),
    writeStderr: (data) => lines.push(typeof data === 'string' ? data : Buffer.from(data).toString('utf8')),
    writeStdout: (data) => lines.push(Buffer.from(data).toString('utf8')),
  });
  return { code, text: lines.join('') };
};

describe('hauler cli', () => {
  it('warns once when the removed legacy state-dir variable is present', () => {
    const lines: string[] = [];
    warnRemovedLegacyStateDir(
      { CARGO_CONDUCTOR_STATE_DIR: '/tmp/dead-path' },
      (line) => lines.push(typeof line === 'string' ? line : Buffer.from(line).toString('utf8')),
    );
    expect(lines).toEqual([
      'warning: CARGO_CONDUCTOR_STATE_DIR is no longer supported; use CARGO_HAULER_STATE_DIR instead.\n',
    ]);
  });

  it('prints usage and exits 2 without arguments', async () => {
    const result = await run([]);
    expect(result.code).toBe(2);
    expect(result.text).toContain('Usage: hauler');
    expect(result.text).toContain('exec');
  });

  it('prints usage and exits 0 for --help', async () => {
    const result = await run(['--help']);
    expect(result.code).toBe(0);
    expect(result.text).toContain('Usage: hauler');
    expect(result.text).toContain('status');
    expect(result.text).toContain('daemon');
  });

  it('projects status/log/last through the RSC catalog as JSON', async () => {
    const status = await run(['status'], { operations: operations() });
    expect(status.code).toBe(0);
    expect(JSON.parse(status.text)).toMatchObject({
      daemon: 'stopped',
      operation: 'status',
      summary: 'cargo-hauler daemon is not running',
    });

    const log = await run(['log', '--limit', '5'], { operations: operations() });
    expect(JSON.parse(log.text)).toMatchObject({ operation: 'log', requests: [] });

    const last = await run(['last'], { operations: operations() });
    expect(JSON.parse(last.text)).toMatchObject({ operation: 'last', request: null });
  });

  it('projects daemon subcommands through the RSC catalog', async () => {
    const result = await run(['daemon', 'status'], { operations: operations() });
    expect(result.code).toBe(1);
    expect(JSON.parse(result.text)).toMatchObject({
      operation: 'daemon',
      running: false,
      subcommand: 'status',
    });
  });

  it('dispatches exec to the streaming client instead of JSON-printing a receipt', async () => {
    let seenArgv: readonly string[] | undefined;
    const result = await run(['exec', '--session', 's1', '--', 'cargo', 'check', '-p', 'alpha'], {
      runExec: (options) => {
        seenArgv = options.argv;
        expect(options.session).toBe('s1');
        return Effect.succeed({ exitCode: 0, mode: 'brokered', ticket: 'cc-9' });
      },
    });
    expect(result.code).toBe(0);
    expect(seenArgv).toEqual(['cargo', 'check', '-p', 'alpha']);
    expect(() => JSON.parse(result.text)).toThrow();
  });

  it('retains legacy host/session metadata because it cannot change state identity', async () => {
    const names = [
      'CARGO_CONDUCTOR_HOST',
      'CARGO_CONDUCTOR_SESSION',
      'CARGO_HAULER_HOST',
      'CARGO_HAULER_SESSION',
    ] as const;
    const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    try {
      process.env.CARGO_CONDUCTOR_HOST = 'legacy-host';
      process.env.CARGO_CONDUCTOR_SESSION = 'legacy-session';
      let seen: RunExecOptions | undefined;
      await run(['exec', '--', 'cargo', 'check'], {
        runExec: (options) => {
          seen = options;
          return Effect.succeed({ exitCode: 0, mode: 'brokered', ticket: 'cc-9' });
        },
      });
      expect(seen?.host).toBe('legacy-host');
      expect(seen?.session).toBe('legacy-session');

      process.env.CARGO_HAULER_HOST = 'current-host';
      process.env.CARGO_HAULER_SESSION = 'current-session';
      await run(['exec', '--', 'cargo', 'check'], {
        runExec: (options) => {
          seen = options;
          return Effect.succeed({ exitCode: 0, mode: 'brokered', ticket: 'cc-10' });
        },
      });
      expect(seen?.host).toBe('current-host');
      expect(seen?.session).toBe('current-session');
    } finally {
      for (const name of names) {
        const value = previous[name];
        if (value === undefined) {
          delete process.env[name];
        } else {
          process.env[name] = value;
        }
      }
    }
  });

  it('returns the cargo exit code from exec and rejects a missing cargo command', async () => {
    const failed = await run(['exec', '--', 'cargo', 'test'], {
      runExec: () => Effect.succeed({ exitCode: 17, mode: 'passthrough' }),
    });
    expect(failed.code).toBe(17);

    const usage = await run(['exec']);
    expect(usage.code).toBe(2);
    expect(usage.text).toContain('Usage: hauler');
  });

  it('prints an exec defect and exits 1 instead of leaking a FiberFailure', async () => {
    const result = await run(['exec', '--', 'cargo', 'check'], {
      runExec: () => Effect.die(new SyntaxError('malformed daemon reply')),
    });

    expect(result.code).toBe(1);
    expect(result.text).toContain('malformed daemon reply');
  });

  it('interrupts exec when the CLI abort signal fires', async () => {
    const controller = new AbortController();
    const pending = run(['exec', '--', 'cargo', 'check'], {
      runExec: () =>
        Effect.sleep('200 millis').pipe(
          Effect.as({ exitCode: 0, mode: 'passthrough' as const }),
        ),
      signal: controller.signal,
    });

    controller.abort();

    await expect(pending).rejects.toBeDefined();
  });

  it('status uses the default snapshot when no operations are injected', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cc-cli-status-'));
    const previous = process.env.CARGO_HAULER_STATE_DIR;
    process.env.CARGO_HAULER_STATE_DIR = join(root, 'state');
    try {
      const result = await run(['status']);
      expect(result.code).toBe(0);
      expect(JSON.parse(result.text)).toMatchObject({
        daemon: 'stopped',
        operation: 'status',
      });
      expect(JSON.parse(result.text).summary).toContain('daemon is not running');
    } finally {
      if (previous === undefined) {
        delete process.env.CARGO_HAULER_STATE_DIR;
      } else {
        process.env.CARGO_HAULER_STATE_DIR = previous;
      }
      rmSync(root, { recursive: true, force: true });
    }
  });
});
