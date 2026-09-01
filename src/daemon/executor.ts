import * as Command from '@effect/platform/Command';
import type * as CommandExecutor from '@effect/platform/CommandExecutor';
import * as Cause from 'effect/Cause';
import * as Deferred from 'effect/Deferred';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Fiber from 'effect/Fiber';
import * as Option from 'effect/Option';
import * as Stream from 'effect/Stream';

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

const signalPattern = /signal:\s*(\w+)/;

/**
 * @effect/platform's Process.exitCode exposes a structured numeric exit only
 * on success. Signal exits arrive as PlatformError message text in the form
 * "... signal: SIGTERM ...", so contain that version-coupled parsing here.
 */
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
  | { readonly kind: 'signaled'; readonly signal: string | null };

type ExecutionEvent =
  | { readonly kind: 'exited'; readonly waited: WaitOutcome }
  | { readonly kind: 'kill-requested' }
  | {
      readonly kind: 'pump-failed';
      readonly channel: 'stdout' | 'stderr';
      readonly cause: Cause.Cause<unknown>;
    };

const defaultKillGraceMs = 8_000;

const killGraceMs = (env: Readonly<Record<string, string>> | undefined): number => {
  const parsed = Number.parseInt(
    env?.CARGO_CONDUCTOR_KILL_GRACE_MS ?? process.env.CARGO_CONDUCTOR_KILL_GRACE_MS ?? '',
    10,
  );
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : defaultKillGraceMs;
};

const buildCommand = (options: ExecuteCargoOptions): Command.Command | undefined => {
  const executable = options.argv[0];
  if (executable === undefined) {
    return undefined;
  }
  // Bare `cargo` must not resolve through PATH: with the conductor shim
  // installed, the daemon would spawn the shim and submit its own work back
  // to itself. CARGO_CONDUCTOR_INSIDE lets the shim pass nested invocations
  // straight through to the real binary.
  const resolved = executable === 'cargo' ? realCargoBin(options.env ?? process.env) : executable;
  const command = Command.stdin(
    Command.workingDirectory(Command.make(resolved, ...options.argv.slice(1)), options.cwd),
    'pipe',
  );
  return Command.env(command, { ...options.env, CARGO_CONDUCTOR_INSIDE: '1' });
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
    default: {
      const _exhaustive: never = waited;
      return _exhaustive;
    }
  }
};

const failedResult = (
  error: string,
  outputTail: string,
  waited?: WaitOutcome,
): ExecutionResult => ({
  outcome: 'failed',
  exitCode: waited?.kind === 'exited' ? waited.code : null,
  signal: waited?.kind === 'signaled' ? waited.signal : null,
  outputTail,
  error,
});

const pumpFailure = (
  channel: 'stdout' | 'stderr',
  fiber: Fiber.Fiber<void, unknown>,
): Effect.Effect<ExecutionEvent> =>
  Fiber.await(fiber).pipe(
    Effect.flatMap((exit) => {
      if (Exit.isFailure(exit)) {
        return Effect.succeed({
          kind: 'pump-failed',
          channel,
          cause: exit.cause,
        } satisfies ExecutionEvent);
      }
      return Effect.never;
    }),
  );

const pumpError = (
  channel: 'stdout' | 'stderr',
  exit: Exit.Exit<void, unknown>,
): string | null =>
  Exit.isFailure(exit)
    ? `${channel} pump failed: ${Cause.pretty(exit.cause)}`
    : null;

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
            const onStdoutLine = options.onStdoutLine;
            const consume = (channel: 'stdout' | 'stderr') => {
              if (channel === 'stdout' && onStdoutLine !== undefined) {
                return child.stdout.pipe(
                  Stream.decodeText(),
                  Stream.splitLines,
                  Stream.runForEach(onStdoutLine),
                );
              }
              return Stream.runForEach(
                channel === 'stdout' ? child.stdout : child.stderr,
                (chunk) => {
                  tail.push(chunk);
                  return options.onOutput(channel, chunk);
                },
              );
            };

            const stdoutFiber = yield* Effect.fork(consume('stdout'));
            const stderrFiber = yield* Effect.fork(consume('stderr'));

            const observedExit = yield* Deferred.make<WaitOutcome>();
            yield* Effect.fork(
              child.exitCode.pipe(
                Effect.match({
                  onSuccess: (code): WaitOutcome => ({ kind: 'exited', code }),
                  onFailure: (error): WaitOutcome => ({
                    kind: 'signaled',
                    signal: parseSignal(error.message),
                  }),
                }),
                Effect.flatMap((waited) => Deferred.succeed(observedExit, waited)),
              ),
            );

            const awaitObservedExit = Deferred.await(observedExit);
            const event = yield* Effect.raceAll([
              awaitObservedExit.pipe(
                Effect.map((waited) => ({ kind: 'exited', waited }) satisfies ExecutionEvent),
              ),
              Deferred.await(options.killSignal).pipe(
                Effect.as({ kind: 'kill-requested' } satisfies ExecutionEvent),
              ),
              pumpFailure('stdout', stdoutFiber),
              pumpFailure('stderr', stderrFiber),
            ]);

            const terminate = (
              reason: string,
            ): Effect.Effect<{ readonly waited?: WaitOutcome; readonly error?: string }> =>
              Effect.gen(function* () {
                const sendSignal = (signal: NodeJS.Signals) =>
                  Effect.try({
                    try: () => {
                      const pid = Number(child.pid);
                      process.kill(process.platform === 'win32' ? pid : -pid, signal);
                    },
                    catch: (cause) => cause,
                  });
                const term = yield* Effect.exit(sendSignal('SIGTERM'));
                if (Exit.isFailure(term)) {
                  return {
                    error: `${reason}: failed to send SIGTERM: ${Cause.pretty(term.cause)}`,
                  };
                }
                const graceful = yield* awaitObservedExit.pipe(
                  Effect.timeoutOption(killGraceMs(options.env)),
                );
                if (Option.isSome(graceful)) {
                  return { waited: graceful.value };
                }
                const killed = yield* Effect.exit(sendSignal('SIGKILL'));
                if (Exit.isFailure(killed)) {
                  return {
                    error: `${reason}: failed to send SIGKILL: ${Cause.pretty(killed.cause)}`,
                  };
                }
                return { waited: yield* awaitObservedExit };
              });

            let waited: WaitOutcome;
            let primaryError: string | null = null;
            switch (event.kind) {
              case 'exited':
                waited = event.waited;
                break;
              case 'kill-requested': {
                const terminated = yield* terminate('kill requested');
                if (terminated.waited === undefined) {
                  return failedResult(
                    terminated.error ?? 'kill requested: termination failed',
                    tail.toString(),
                  );
                }
                waited = terminated.waited;
                primaryError = terminated.error ?? null;
                break;
              }
              case 'pump-failed': {
                primaryError = `${event.channel} pump failed: ${Cause.pretty(event.cause)}`;
                const terminated = yield* terminate(primaryError);
                if (terminated.waited === undefined) {
                  return failedResult(
                    [primaryError, terminated.error].filter((value) => value !== undefined).join('; '),
                    tail.toString(),
                  );
                }
                waited = terminated.waited;
                break;
              }
              default: {
                const _exhaustive: never = event;
                return _exhaustive;
              }
            }

            const [stdoutExit, stderrExit] = yield* Fiber.awaitAll([stdoutFiber, stderrFiber]);
            const errors = [
              primaryError,
              pumpError('stdout', stdoutExit),
              pumpError('stderr', stderrExit),
            ].filter((error): error is string => error !== null);
            if (errors.length > 0) {
              return failedResult([...new Set(errors)].join('; '), tail.toString(), waited);
            }

            return toResult(waited, tail.toString());
          }),
      }),
    ),
  );
};
