import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as NodeServices from '@effect/platform-node/NodeServices';
import { describe, expect, it } from 'effect-rstest';
import * as Deferred from 'effect/Deferred';
import * as Effect from 'effect/Effect';
import type * as Scope from 'effect/Scope';

import { buildRelevantEnv } from '../src/client/env.js';
import type { ExecuteCargoOptions, ExecutionResult } from '../src/daemon/executor.js';
import { executeCargo, TailBuffer } from '../src/daemon/executor.js';

const scriptSource = `#!/usr/bin/env bash
if [ "$1" = pwd ]; then
  pwd
  exit 0
fi
if [ "$1" = unterminated ]; then
  printf "last-fragment"
  exit 0
fi
if [ "$1" = color ]; then
  echo "color:\${CARGO_TERM_COLOR:-unset}"
  exit 0
fi
echo "out:$1"
echo "err:$1" >&2
if [ "$1" = trap-term ]; then
  trap 'exit 7' TERM
  while true; do sleep 0.1; done
fi
if [ "$1" = ignore-term ]; then
  trap '' TERM
  while true; do sleep 0.1; done
fi
if [ -n "$FAKE_SLEEP" ]; then sleep "$FAKE_SLEEP"; fi
exit "\${FAKE_EXIT:-0}"
`;

interface Workspace {
  readonly dir: string;
  readonly script: string;
}

/** A temp dir holding the fake cargo script, removed when the scope closes. */
const scopedWorkspace: Effect.Effect<Workspace, never, Scope.Scope> = Effect.acquireRelease(
  Effect.sync(() => {
    const dir = mkdtempSync(join(tmpdir(), 'cargo-hauler-exec-'));
    const script = join(dir, 'fake-cargo');
    writeFileSync(script, scriptSource);
    chmodSync(script, 0o755);
    return { dir, script };
  }),
  ({ dir }) => Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
);

const unusedKill = (): Deferred.Deferred<void> => Deferred.makeUnsafe<void>();

const runExecute = (options: ExecuteCargoOptions): Effect.Effect<ExecutionResult> =>
  executeCargo(options).pipe(Effect.provide(NodeServices.layer));

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

  it('keeps only the final capacity bytes of one oversized chunk', () => {
    const tail = new TailBuffer(5);
    tail.push(Buffer.from('0123456789'));
    expect(tail.toString()).toBe('56789');
  });

  it('preserves captured ANSI verbatim (color is a display-time decision)', () => {
    const colored = 'import\u001b[0m\n \u001b[1m\u001b[94m--> \u001b[0msrc/lib.rs:3:5\n';
    const tail = new TailBuffer(4096);
    tail.push(Buffer.from(colored));
    expect(tail.toString()).toBe(colored);
  });
});

describe('executeCargo', () => {
  it.live('reports done on exit 0 and streams both channels', () =>
    Effect.gen(function* () {
      const { dir, script } = yield* scopedWorkspace;
      const stdout: Uint8Array[] = [];
      const stderr: Uint8Array[] = [];

      const result = yield* runExecute({
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
    }));

  it.live('delivers env and reports failed for a non-zero exit', () =>
    Effect.gen(function* () {
      const { dir, script } = yield* scopedWorkspace;

      const result = yield* runExecute({
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
    }));

  it.live('captures color by default: the pipe would otherwise make auto mean never', () =>
    Effect.gen(function* () {
      const { dir, script } = yield* scopedWorkspace;

      const result = yield* runExecute({
        argv: [script, 'color'],
        cwd: dir,
        killSignal: unusedKill(),
        tailBytes: 4096,
        onOutput: () => Effect.void,
      });

      expect(result.outcome).toBe('done');
      expect(result.outputTail).toContain('color:always');
    }));

  it.live('respects an explicit caller CARGO_TERM_COLOR over the capture default', () =>
    Effect.gen(function* () {
      const { dir, script } = yield* scopedWorkspace;

      const result = yield* runExecute({
        argv: [script, 'color'],
        cwd: dir,
        env: { CARGO_TERM_COLOR: 'never' },
        killSignal: unusedKill(),
        tailBytes: 4096,
        onOutput: () => Effect.void,
      });

      expect(result.outcome).toBe('done');
      expect(result.outputTail).toContain('color:never');
    }));

  it.live('honors a caller NO_COLOR by spawning with color off', () =>
    Effect.gen(function* () {
      const { dir, script } = yield* scopedWorkspace;

      const result = yield* runExecute({
        argv: [script, 'color'],
        cwd: dir,
        env: { NO_COLOR: '1' },
        killSignal: unusedKill(),
        tailBytes: 4096,
        onOutput: () => Effect.void,
      });

      expect(result.outcome).toBe('done');
      expect(result.outputTail).toContain('color:never');
    }));

  it.live('sees a caller NO_COLOR through the client env transport end to end', () =>
    Effect.gen(function* () {
      const { dir, script } = yield* scopedWorkspace;

      // The exact env `hauler exec` ships: NO_COLOR must survive the
      // relevance filter, or the executor falls back to forcing color.
      const result = yield* runExecute({
        argv: [script, 'color'],
        cwd: dir,
        env: buildRelevantEnv({ HOME: '/home/alice', NO_COLOR: '1', TERM: 'xterm-256color' }),
        killSignal: unusedKill(),
        tailBytes: 4096,
        onOutput: () => Effect.void,
      });

      expect(result.outcome).toBe('done');
      expect(result.outputTail).toContain('color:never');
    }));

  it.live('runs the child with the requested cwd', () =>
    Effect.gen(function* () {
      const { dir, script } = yield* scopedWorkspace;

      const result = yield* runExecute({
        argv: [script, 'pwd'],
        cwd: dir,
        killSignal: unusedKill(),
        tailBytes: 4096,
        onOutput: () => Effect.void,
      });

      expect(result.outcome).toBe('done');
      expect(result.outputTail).toContain(realpathSync(dir));
    }));

  it.live('emits a trailing unterminated stdout fragment through the line callback', () =>
    Effect.gen(function* () {
      const { dir, script } = yield* scopedWorkspace;
      const lines: string[] = [];

      const result = yield* runExecute({
        argv: [script, 'unterminated'],
        cwd: dir,
        killSignal: unusedKill(),
        tailBytes: 4096,
        onOutput: () => Effect.void,
        onStdoutLine: (line) =>
          Effect.sync(() => {
            lines.push(line);
          }),
      });

      expect(result.outcome).toBe('done');
      expect(lines).toEqual(['last-fragment']);
      expect(result.outputTail).toBe('');
    }));

  it.live('kills the process group when killSignal completes', () =>
    Effect.gen(function* () {
      const { dir, script } = yield* scopedWorkspace;
      const killSignal = unusedKill();
      const started = Date.now();

      const result = yield* runExecute({
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
    }));

  it.live('classifies the observed natural exit when it races a kill request', () =>
    Effect.gen(function* () {
      const { dir, script } = yield* scopedWorkspace;
      const killSignal = unusedKill();

      const result = yield* runExecute({
        argv: [script, 'trap-term'],
        cwd: dir,
        killSignal,
        tailBytes: 4096,
        onOutput: (channel) =>
          channel === 'stdout'
            ? Deferred.succeed(killSignal, undefined).pipe(Effect.asVoid)
            : Effect.void,
      });

      expect(result.outcome).toBe('failed');
      expect(result.exitCode).toBe(7);
      expect(result.signal).toBeNull();
    }));

  it.live('escalates to SIGKILL after the configured termination grace period', () =>
    Effect.gen(function* () {
      const { dir, script } = yield* scopedWorkspace;
      const killSignal = unusedKill();
      const started = Date.now();

      const result = yield* runExecute({
        argv: [script, 'ignore-term'],
        cwd: dir,
        env: { CARGO_HAULER_KILL_GRACE_MS: '100' },
        killSignal,
        tailBytes: 4096,
        onOutput: (channel) =>
          channel === 'stdout'
            ? Deferred.succeed(killSignal, undefined).pipe(Effect.asVoid)
            : Effect.void,
      });

      expect(result.outcome).toBe('killed');
      expect(result.signal).toBe('SIGKILL');
      expect(result.exitCode).toBeNull();
      expect(Date.now() - started).toBeLessThan(2500);
    }));

  it.live('surfaces a stream pump failure and terminates the child', () =>
    Effect.gen(function* () {
      const { dir, script } = yield* scopedWorkspace;
      const started = Date.now();

      const result = yield* runExecute({
        argv: [script, 'ignore-term'],
        cwd: dir,
        env: { CARGO_HAULER_KILL_GRACE_MS: '100' },
        killSignal: unusedKill(),
        tailBytes: 4096,
        onOutput: (channel) =>
          channel === 'stdout' ? Effect.die(new Error('consumer exploded')) : Effect.void,
      });

      expect(result.outcome).toBe('failed');
      expect(result.error).toContain('stdout pump failed');
      expect(result.error).toContain('consumer exploded');
      expect(Date.now() - started).toBeLessThan(2500);
    }));

  it.live('reports failed with an error when the executable is missing', () =>
    Effect.gen(function* () {
      const { dir } = yield* scopedWorkspace;

      const result = yield* runExecute({
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
    }));
});
