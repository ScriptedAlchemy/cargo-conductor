import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from '@rstest/core';
import * as Effect from 'effect/Effect';

import { runCli, type ConductorOperations } from '../src/cli.js';
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
  summary: 'cargo-conductor daemon is not running',
};

const operations = (): ConductorOperations => ({
  daemon: async (input) => ({
    message: input.subcommand === 'status' ? 'cargo-conductor daemon is not running' : `${input.subcommand} ok`,
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
    summary: 'no conductor requests recorded',
  }),
  log: async () => ({
    daemon: 'stopped',
    operation: 'log',
    requests: [],
    summary: 'no conductor requests recorded',
  }),
  status: async () => ({
    ...stoppedSnapshot,
    operation: 'status',
  }),
});

const run = async (
  argv: readonly string[],
  extras: {
    readonly operations?: ConductorOperations;
    readonly runExec?: (options: RunExecOptions) => Effect.Effect<RunExecResult>;
  } = {},
): Promise<{ readonly code: number; readonly text: string }> => {
  const lines: string[] = [];
  const code = await runCli(argv, {
    ...(extras.operations === undefined ? {} : { operations: extras.operations }),
    ...(extras.runExec === undefined ? {} : { runExec: extras.runExec }),
    write: (line) => lines.push(line),
    writeStderr: (data) => lines.push(typeof data === 'string' ? data : Buffer.from(data).toString('utf8')),
    writeStdout: (data) => lines.push(Buffer.from(data).toString('utf8')),
  });
  return { code, text: lines.join('') };
};

describe('conductor cli', () => {
  it('prints usage and exits 2 without arguments', async () => {
    const result = await run([]);
    expect(result.code).toBe(2);
    expect(result.text).toContain('Usage: conductor');
    expect(result.text).toContain('exec');
  });

  it('prints usage and exits 0 for --help', async () => {
    const result = await run(['--help']);
    expect(result.code).toBe(0);
    expect(result.text).toContain('Usage: conductor');
    expect(result.text).toContain('status');
    expect(result.text).toContain('daemon');
  });

  it('projects status/log/last through the RSC catalog as JSON', async () => {
    const status = await run(['status'], { operations: operations() });
    expect(status.code).toBe(0);
    expect(JSON.parse(status.text)).toMatchObject({
      daemon: 'stopped',
      operation: 'status',
      summary: 'cargo-conductor daemon is not running',
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

  it('returns the cargo exit code from exec and rejects a missing cargo command', async () => {
    const failed = await run(['exec', '--', 'cargo', 'test'], {
      runExec: () => Effect.succeed({ exitCode: 17, mode: 'passthrough' }),
    });
    expect(failed.code).toBe(17);

    const usage = await run(['exec']);
    expect(usage.code).toBe(2);
    expect(usage.text).toContain('Usage: conductor');
  });

  it('status uses the default snapshot when no operations are injected', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cc-cli-status-'));
    const previous = process.env.CARGO_CONDUCTOR_STATE_DIR;
    process.env.CARGO_CONDUCTOR_STATE_DIR = join(root, 'state');
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
        delete process.env.CARGO_CONDUCTOR_STATE_DIR;
      } else {
        process.env.CARGO_CONDUCTOR_STATE_DIR = previous;
      }
      rmSync(root, { recursive: true, force: true });
    }
  });
});
