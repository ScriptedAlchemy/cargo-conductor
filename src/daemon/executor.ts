import * as Deferred from 'effect/Deferred';
import * as Effect from 'effect/Effect';
import * as Fiber from 'effect/Fiber';
import * as Stream from 'effect/Stream';
import * as ChildProcess from 'effect/unstable/process/ChildProcess';
import type * as ChildProcessSpawner from 'effect/unstable/process/ChildProcessSpawner';

import { LineBuffer } from './protocol.js';
import { realCargoBin } from './real-cargo.js';

export interface ExecuteCargoOptions {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>> | undefined;
  /** Completing this deferred requests termination (SIGTERM to the process group). */
  readonly killSignal: Deferred.Deferred<void>;
  /** Capacity of the retained combined-output tail, in bytes. */
  readonly tailBytes: number;
  readonly onOutput: (channel: 'stdout' | 'stderr', data: Uint8Array) => Effect.Effect<void>;
  /**
   * When set, stdout is consumed line-by-line through this callback instead
   * of `onOutput`, and raw stdout bytes stay out of the tail (the caller owns
   * the rendered view). Used for `--message-format=json` demultiplexing.
   */
  readonly onStdoutLine?: (line: string) => Effect.Effect<void>;
}

export interface ExecutionResult {
  readonly outcome: 'done' | 'failed' | 'killed';
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly outputTail: string;
  readonly error: string | null;
}

export class TailBuffer {
  readonly #capacity: number;
  #bytes: Buffer = Buffer.alloc(0);

  constructor(capacity: number) {
    this.#capacity = Math.max(0, capacity);
  }

  push(data: Uint8Array): void {
    if (this.#capacity === 0 || data.byteLength === 0) {
      return;
    }
    const next = Buffer.concat([this.#bytes, Buffer.from(data)]);
    this.#bytes =
      next.byteLength > this.#capacity ? next.subarray(next.byteLength - this.#capacity) : next;
  }

  toString(): string {
    // A trimmed leading partial multi-byte UTF-8 character is acceptable (lossy head).
    return this.#bytes.toString('utf8');
  }
}

// The platform reports signal exits as "Process interrupted due to receipt
// of signal: 'SIGTERM'". Since effect v4 that text lives on the cause chain:
// the surfaced PlatformError message is just "Unknown: ChildProcess.exitCode
// (...)" with the signal error attached as its cause.
const signalPattern = /signal:\s*'?(\w+)'?/;

const parseSignal = (error: unknown): string | null => {
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (typeof current === 'object' && current !== null && !seen.has(current)) {
    seen.add(current);
    const candidate = current as { readonly message?: unknown; readonly cause?: unknown };
    if (typeof candidate.message === 'string') {
      const match = signalPattern.exec(candidate.message);
      if (match?.[1] !== undefined) {
        return match[1];
      }
    }
    current = candidate.cause ?? null;
  }
  return null;
};

const spawnFailure = (message: string): ExecutionResult => ({
  outcome: 'failed',
  exitCode: null,
  signal: null,
  outputTail: '',
  error: message,
});

type WaitOutcome =
  | { readonly kind: 'exited'; readonly code: number }
  | { readonly kind: 'signaled'; readonly signal: string | null }
  | { readonly kind: 'requested' };

const buildCommand = (options: ExecuteCargoOptions): ChildProcess.StandardCommand | undefined => {
  const executable = options.argv[0];
  if (executable === undefined) {
    return undefined;
  }
  // Bare `cargo` must not resolve through PATH: with the conductor shim
  // installed, the daemon would spawn the shim and submit its own work back
  // to itself. CARGO_CONDUCTOR_INSIDE lets the shim pass nested invocations
  // straight through to the real binary.
  const resolved = executable === 'cargo' ? realCargoBin(options.env ?? process.env) : executable;
  // `env` is a delta on top of the caller environment; extendEnv keeps the
  // inherited PATH/HOME etc. (v4 replaces the environment by default).
  return ChildProcess.make(resolved, options.argv.slice(1), {
    cwd: options.cwd,
    env: { ...options.env, CARGO_CONDUCTOR_INSIDE: '1' },
    extendEnv: true,
    stdin: 'pipe',
  });
};

const toResult = (waited: WaitOutcome, outputTail: string): ExecutionResult => {
  switch (waited.kind) {
    case 'exited':
      return {
        outcome: waited.code === 0 ? 'done' : 'failed',
        exitCode: waited.code,
        signal: null,
        outputTail,
        error: null,
      };
    case 'signaled':
      return {
        outcome: 'killed',
        exitCode: null,
        signal: waited.signal,
        outputTail,
        error: null,
      };
    case 'requested':
      return {
        outcome: 'killed',
        exitCode: null,
        signal: 'SIGTERM',
        outputTail,
        error: null,
      };
    default: {
      const _exhaustive: never = waited;
      return _exhaustive;
    }
  }
};

export const executeCargo = (
  options: ExecuteCargoOptions,
): Effect.Effect<ExecutionResult, never, ChildProcessSpawner.ChildProcessSpawner> => {
  const command = buildCommand(options);
  if (command === undefined) {
    return Effect.succeed(spawnFailure('argv must be non-empty'));
  }

  const tail = new TailBuffer(options.tailBytes);

  return Effect.scoped(
    command.pipe(
      Effect.matchEffect({
        onFailure: (error) => Effect.succeed(spawnFailure(error.message)),
        onSuccess: (child) =>
          Effect.gen(function* () {
            const onStdoutLine = options.onStdoutLine;
            const stdoutLines = new LineBuffer();
            const consume = (channel: 'stdout' | 'stderr') =>
              Stream.runForEach(channel === 'stdout' ? child.stdout : child.stderr, (chunk) => {
                if (channel === 'stdout' && onStdoutLine !== undefined) {
                  return Effect.forEach(stdoutLines.push(chunk), onStdoutLine, {
                    discard: true,
                  });
                }
                tail.push(chunk);
                return options.onOutput(channel, chunk);
              }).pipe(
                Effect.andThen(
                  channel === 'stdout' && onStdoutLine !== undefined
                    ? Effect.suspend(() => {
                        const remainder = stdoutLines.flush();
                        return remainder === null ? Effect.void : onStdoutLine(remainder);
                      })
                    : Effect.void,
                ),
              );

            const stdoutFiber = yield* Effect.forkChild(consume('stdout'));
            const stderrFiber = yield* Effect.forkChild(consume('stderr'));

            const waited = yield* Effect.race(
              child.exitCode.pipe(
                Effect.match({
                  onSuccess: (code): WaitOutcome => ({ kind: 'exited', code }),
                  onFailure: (error): WaitOutcome => ({
                    kind: 'signaled',
                    signal: parseSignal(error),
                  }),
                }),
              ),
              Deferred.await(options.killSignal).pipe(
                // handle.kill signals the child's process group (the child is
                // spawned detached, so rustc children die too) and resolves
                // once the process has exited.
                Effect.andThen(child.kill({ killSignal: 'SIGTERM' }).pipe(Effect.ignore)),
                Effect.as({ kind: 'requested' } satisfies WaitOutcome),
              ),
            );

            yield* Fiber.join(stdoutFiber).pipe(Effect.ignore);
            yield* Fiber.join(stderrFiber).pipe(Effect.ignore);

            return toResult(waited, tail.toString());
          }),
      }),
    ),
  );
};
