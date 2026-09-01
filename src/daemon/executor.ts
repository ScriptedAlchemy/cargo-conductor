import * as Command from '@effect/platform/Command';
import type * as CommandExecutor from '@effect/platform/CommandExecutor';
import * as Deferred from 'effect/Deferred';
import * as Effect from 'effect/Effect';
import * as Fiber from 'effect/Fiber';
import * as Stream from 'effect/Stream';

export interface ExecuteCargoOptions {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>> | undefined;
  /** Completing this deferred requests termination (SIGTERM to the process group). */
  readonly killSignal: Deferred.Deferred<void>;
  /** Capacity of the retained combined-output tail, in bytes. */
  readonly tailBytes: number;
  readonly onOutput: (channel: 'stdout' | 'stderr', data: Uint8Array) => Effect.Effect<void>;
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

const signalPattern = /signal:\s*(\w+)/;

const parseSignal = (message: string): string | null => {
  const match = signalPattern.exec(message);
  return match?.[1] ?? null;
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

const buildCommand = (options: ExecuteCargoOptions): Command.Command | undefined => {
  const executable = options.argv[0];
  if (executable === undefined) {
    return undefined;
  }
  let command = Command.stdin(
    Command.workingDirectory(Command.make(executable, ...options.argv.slice(1)), options.cwd),
    'pipe',
  );
  if (options.env !== undefined) {
    command = Command.env(command, { ...options.env });
  }
  return command;
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
): Effect.Effect<ExecutionResult, never, CommandExecutor.CommandExecutor> => {
  const command = buildCommand(options);
  if (command === undefined) {
    return Effect.succeed(spawnFailure('argv must be non-empty'));
  }

  const tail = new TailBuffer(options.tailBytes);

  return Effect.scoped(
    Command.start(command).pipe(
      Effect.matchEffect({
        onFailure: (error) => Effect.succeed(spawnFailure(error.message)),
        onSuccess: (child) =>
          Effect.gen(function* () {
            const consume = (channel: 'stdout' | 'stderr') =>
              Stream.runForEach(channel === 'stdout' ? child.stdout : child.stderr, (chunk) => {
                tail.push(chunk);
                return options.onOutput(channel, chunk);
              });

            const stdoutFiber = yield* Effect.fork(consume('stdout'));
            const stderrFiber = yield* Effect.fork(consume('stderr'));

            const waited = yield* Effect.race(
              child.exitCode.pipe(
                Effect.match({
                  onSuccess: (code): WaitOutcome => ({ kind: 'exited', code }),
                  onFailure: (error): WaitOutcome => ({
                    kind: 'signaled',
                    signal: parseSignal(error.message),
                  }),
                }),
              ),
              Deferred.await(options.killSignal).pipe(
                Effect.zipRight(child.kill('SIGTERM').pipe(Effect.ignore)),
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
