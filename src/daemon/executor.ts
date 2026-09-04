import * as Cause from 'effect/Cause';
import * as Deferred from 'effect/Deferred';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Fiber from 'effect/Fiber';
import * as Stream from 'effect/Stream';
import * as ChildProcess from 'effect/unstable/process/ChildProcess';
import type * as ChildProcessSpawner from 'effect/unstable/process/ChildProcessSpawner';

import { isRecord } from '../lib/guards.js';

import { cargoExecutablePattern } from './intent-normalizer.js';
import { sharedJobserverDelta } from './jobserver.js';
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
  /**
   * Point the child's stderr at its stdout pipe so both channels share one
   * file description and the kernel keeps the program's write order; every
   * byte then arrives on `stdout`. Mutually exclusive with `onStdoutLine`.
   */
  readonly mergeStderr?: boolean;
  /** Called once with the child's pid right after it is spawned (stall sampling root). */
  readonly onSpawn?: (pid: number) => Effect.Effect<void>;
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
  #chunks: Buffer[] = [];
  #head = 0;
  #bytes = 0;

  constructor(capacity: number) {
    this.#capacity = Math.max(0, capacity);
  }

  push(data: Uint8Array): void {
    if (this.#capacity === 0 || data.byteLength === 0) {
      return;
    }
    const chunk = Buffer.from(data);
    if (chunk.byteLength >= this.#capacity) {
      this.#chunks = [chunk.subarray(chunk.byteLength - this.#capacity)];
      this.#head = 0;
      this.#bytes = this.#capacity;
      return;
    }
    this.#chunks.push(chunk);
    this.#bytes += chunk.byteLength;
    let overflow = this.#bytes - this.#capacity;
    while (overflow > 0) {
      const oldest = this.#chunks[this.#head];
      if (oldest === undefined) {
        break;
      }
      if (oldest.byteLength <= overflow) {
        this.#head += 1;
        this.#bytes -= oldest.byteLength;
        overflow -= oldest.byteLength;
        continue;
      }
      this.#chunks[this.#head] = oldest.subarray(overflow);
      this.#bytes -= overflow;
      overflow = 0;
    }
    if (this.#head > 1_024 || this.#head * 2 >= this.#chunks.length) {
      this.#chunks = this.#chunks.slice(this.#head);
      this.#head = 0;
    }
  }

  toString(): string {
    // Captured verbatim, ANSI included: whether color survives is decided
    // per consumer at display time, not at capture time. A trimmed leading
    // partial multi-byte UTF-8 character is acceptable (lossy head).
    return Buffer.concat(this.#chunks.slice(this.#head), this.#bytes).toString('utf8');
  }
}

const signalPattern = /signal:\s*'?(\w+)'?/;

/**
 * The platform's ChildProcess.exitCode exposes a structured numeric exit only
 * on success. Signal exits arrive as PlatformError text in the form
 * "... signal: 'SIGTERM' ...", and since effect v4 that text lives on the
 * cause chain: the surfaced error message is just "Unknown:
 * ChildProcess.exitCode (...)" with the signal error attached as its cause.
 * Contain that version-coupled parsing here.
 */
const parseSignal = (error: unknown): string | null => {
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (isRecord(current) && !seen.has(current)) {
    seen.add(current);
    if (typeof current.message === 'string') {
      const match = signalPattern.exec(current.message);
      if (match?.[1] !== undefined) {
        return match[1];
      }
    }
    current = current.cause ?? null;
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
    env?.CARGO_HAULER_KILL_GRACE_MS ??
      env?.CARGO_CONDUCTOR_KILL_GRACE_MS ??
      process.env.CARGO_HAULER_KILL_GRACE_MS ??
      process.env.CARGO_CONDUCTOR_KILL_GRACE_MS ??
      '',
    10,
  );
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : defaultKillGraceMs;
};

const buildCommand = (options: ExecuteCargoOptions): ChildProcess.StandardCommand | undefined => {
  const executable = options.argv[0];
  if (executable === undefined) {
    return undefined;
  }
  // Bare `cargo` must not resolve through PATH: with the hauler shim
  // installed, the daemon would spawn the shim and submit its own work back
  // to itself. CARGO_HAULER_INSIDE lets the shim pass nested invocations
  // straight through to the real binary.
  const resolved = executable === 'cargo' ? realCargoBin(options.env ?? process.env) : executable;
  // A daemon-spawned cargo joins the machine-wide jobserver pool, so
  // concurrent lanes share one global rustc parallelism budget instead of
  // each sizing a private machine-width pool. The delta is null when this
  // process holds no armed pool (client passthroughs) or the invocation
  // pins its own parallelism; the spread order keeps caller-provided
  // MAKEFLAGS authoritative.
  const jobserver = cargoExecutablePattern.test(executable)
    ? (sharedJobserverDelta({ ...process.env, ...options.env }) ?? {})
    : {};
  // The child's stdout/stderr are captured pipes, so cargo's `auto` would
  // mean never and every consumer — including a live TTY — would lose
  // color. Capture color instead (`always`), and let each consumer decide
  // at display time whether to keep or strip it. A caller's explicit
  // CARGO_TERM_COLOR stays authoritative, and a caller NO_COLOR (when
  // present without an explicit color choice) means never per its contract.
  const color =
    options.env?.CARGO_TERM_COLOR !== undefined
      ? {}
      : options.env?.NO_COLOR !== undefined && options.env.NO_COLOR !== ''
        ? { CARGO_TERM_COLOR: 'never' }
        : { CARGO_TERM_COLOR: 'always' };
  // A merged run goes through `sh -c 'exec … 2>&1'`: the spawner has no
  // dup2 option, and `exec` keeps cargo's pid (so group kills still land)
  // while the shell only performs the redirection.
  const [program, args] =
    options.mergeStderr === true && options.onStdoutLine === undefined
      ? ['/bin/sh', ['-c', 'exec "$0" "$@" 2>&1', resolved, ...options.argv.slice(1)]]
      : [resolved, options.argv.slice(1)];
  // `env` is a delta on top of the caller environment; extendEnv keeps the
  // inherited PATH/HOME etc. (v4 replaces the environment by default).
  return ChildProcess.make(program, args, {
    cwd: options.cwd,
    env: { ...color, ...jobserver, ...options.env, CARGO_HAULER_INSIDE: '1' },
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

/** How long to keep reading after the child exited before abandoning a pipe held open by a descendant. */
const pumpDrainGraceMs = 1_000;

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

/** A pump we interrupted ourselves (drain grace elapsed) is not a failure. */
const pumpError = (
  channel: 'stdout' | 'stderr',
  exit: Exit.Exit<void, unknown>,
): string | null =>
  Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)
    ? `${channel} pump failed: ${Cause.pretty(exit.cause)}`
    : null;

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
            if (options.onSpawn !== undefined) {
              yield* options.onSpawn(child.pid);
            }
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

            const stdoutFiber = yield* Effect.forkChild(consume('stdout'));
            const stderrFiber = yield* Effect.forkChild(consume('stderr'));

            const observedExit = yield* Deferred.make<WaitOutcome>();
            yield* Effect.forkChild(
              child.exitCode.pipe(
                Effect.match({
                  onSuccess: (code): WaitOutcome => ({ kind: 'exited', code }),
                  onFailure: (error): WaitOutcome => ({
                    kind: 'signaled',
                    signal: parseSignal(error),
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
                // handle.kill signals the child's process group (the child is
                // spawned detached, so rustc children die too), waits for the
                // process to exit, and escalates to a group SIGKILL if it
                // survives the grace window.
                const killed = yield* Effect.exit(
                  child.kill({
                    killSignal: 'SIGTERM',
                    forceKillAfter: killGraceMs(options.env),
                  }),
                );
                if (Exit.isFailure(killed)) {
                  return {
                    error: `${reason}: failed to terminate: ${Cause.pretty(killed.cause)}`,
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

            // Pipe EOF needs every writer gone. Once the child itself has
            // exited, a descendant that survived (an orphaned helper, a
            // daemonized process) must not keep the ticket from settling:
            // drain briefly, then stop reading and let it go.
            const drained = yield* Fiber.awaitAll([stdoutFiber, stderrFiber]).pipe(
              Effect.timeoutOption(pumpDrainGraceMs),
            );
            const [stdoutExit, stderrExit] =
              drained._tag === 'Some'
                ? drained.value
                : yield* Effect.andThen(
                    Fiber.interruptAll([stdoutFiber, stderrFiber]),
                    Fiber.awaitAll([stdoutFiber, stderrFiber]),
                  );
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
