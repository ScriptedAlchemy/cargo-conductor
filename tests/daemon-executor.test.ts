import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as NodeContext from '@effect/platform-node/NodeContext';
import { afterEach, describe, expect, it } from '@rstest/core';
import * as Deferred from 'effect/Deferred';
import * as Effect from 'effect/Effect';

import type { ExecuteCargoOptions, ExecutionResult } from '../src/daemon/executor.js';
import { executeCargo, TailBuffer } from '../src/daemon/executor.js';

const scriptSource = `#!/usr/bin/env bash
if [ "$1" = pwd ]; then
  pwd
  exit 0
fi
echo "out:$1"
echo "err:$1" >&2
if [ -n "$FAKE_SLEEP" ]; then sleep "$FAKE_SLEEP"; fi
exit "\${FAKE_EXIT:-0}"
`;

const temps: string[] = [];

const makeWorkspace = (): { readonly dir: string; readonly script: string } => {
  const dir = mkdtempSync(join(tmpdir(), 'cargo-conductor-exec-'));
  temps.push(dir);
  const script = join(dir, 'fake-cargo');
  writeFileSync(script, scriptSource);
  chmodSync(script, 0o755);
  return { dir, script };
};

afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const unusedKill = (): Deferred.Deferred<void> => Effect.runSync(Deferred.make<void>());

const runExecute = (options: ExecuteCargoOptions): Promise<ExecutionResult> =>
  Effect.runPromise(executeCargo(options).pipe(Effect.provide(NodeContext.layer)));

const concatUtf8 = (chunks: readonly Uint8Array[]): string => Buffer.concat(chunks).toString('utf8');

describe('TailBuffer', () => {
  it('keeps the last bytes when capacity is exceeded across pushes', () => {
    const tail = new TailBuffer(5);
    tail.push(Buffer.from('aaa'));
    tail.push(Buffer.from('bbb'));
    tail.push(Buffer.from('ccc'));
    expect(tail.toString()).toBe('bbccc');
  });

  it('accumulates pushed chunks losslessly while under capacity', () => {
    const tail = new TailBuffer(32);
    tail.push(Buffer.from('hello'));
    tail.push(Buffer.from(' '));
    tail.push(Buffer.from('world'));
    expect(tail.toString()).toBe('hello world');
  });
});

describe('executeCargo', () => {
  it('reports done on exit 0 and streams both channels', async () => {
    const { dir, script } = makeWorkspace();
    const stdout: Uint8Array[] = [];
    const stderr: Uint8Array[] = [];

    const result = await runExecute({
      argv: [script, 'hello'],
      cwd: dir,
      killSignal: unusedKill(),
      tailBytes: 4096,
      onOutput: (channel, data) =>
        Effect.sync(() => {
          switch (channel) {
            case 'stdout':
              stdout.push(data);
              break;
            case 'stderr':
              stderr.push(data);
              break;
            default: {
              const _exhaustive: never = channel;
              return _exhaustive;
            }
          }
        }),
    });

    expect(result).toEqual({
      outcome: 'done',
      exitCode: 0,
      signal: null,
      outputTail: expect.stringContaining('out:hello') as string,
      error: null,
    });
    expect(result.outputTail).toContain('err:hello');
    expect(concatUtf8(stdout)).toBe('out:hello\n');
    expect(concatUtf8(stderr)).toBe('err:hello\n');
  });

  it('delivers env and reports failed for a non-zero exit', async () => {
    const { dir, script } = makeWorkspace();

    const result = await runExecute({
      argv: [script, 'nope'],
      cwd: dir,
      env: { FAKE_EXIT: '3' },
      killSignal: unusedKill(),
      tailBytes: 4096,
      onOutput: () => Effect.void,
    });

    expect(result.outcome).toBe('failed');
    expect(result.exitCode).toBe(3);
    expect(result.signal).toBeNull();
    expect(result.error).toBeNull();
  });

  it('runs the child with the requested cwd', async () => {
    const { dir, script } = makeWorkspace();

    const result = await runExecute({
      argv: [script, 'pwd'],
      cwd: dir,
      killSignal: unusedKill(),
      tailBytes: 4096,
      onOutput: () => Effect.void,
    });

    expect(result.outcome).toBe('done');
    expect(result.outputTail).toContain(realpathSync(dir));
  });

  it('kills the process group when killSignal completes', async () => {
    const { dir, script } = makeWorkspace();
    const killSignal = unusedKill();
    const started = Date.now();

    const result = await runExecute({
      argv: [script, 'slow'],
      cwd: dir,
      env: { FAKE_SLEEP: '5' },
      killSignal,
      tailBytes: 4096,
      onOutput: () => Deferred.succeed(killSignal, undefined).pipe(Effect.asVoid),
    });

    expect(result.outcome).toBe('killed');
    expect(result.signal).toBe('SIGTERM');
    expect(result.exitCode).toBeNull();
    expect(Date.now() - started).toBeLessThan(2500);
  });

  it('reports failed with an error when the executable is missing', async () => {
    const { dir } = makeWorkspace();

    const result = await runExecute({
      argv: [join(dir, 'missing-binary'), 'hello'],
      cwd: dir,
      killSignal: unusedKill(),
      tailBytes: 4096,
      onOutput: () => Effect.void,
    });

    expect(result.outcome).toBe('failed');
    expect(result.exitCode).toBeNull();
    expect(result.signal).toBeNull();
    expect(result.error).toEqual(expect.any(String));
    expect(result.error?.length).toBeGreaterThan(0);
  });
});
