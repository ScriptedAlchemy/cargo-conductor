import { appendFileSync, mkdirSync } from 'node:fs';
import { constants as osConstants } from 'node:os';
import { join } from 'node:path';

import * as NodeServices from '@effect/platform-node/NodeServices';
import * as NodeSocket from '@effect/platform-node/NodeSocket';
import type { AgentTerminal } from 'agent-bundle';
import * as Cause from 'effect/Cause';
import * as Deferred from 'effect/Deferred';
import * as Effect from 'effect/Effect';
import * as Fiber from 'effect/Fiber';
import * as Ref from 'effect/Ref';
import * as Schedule from 'effect/Schedule';
import type { Scope } from 'effect/Scope';

import { executeCargo } from '../daemon/executor.js';
import { resolveDaemonConfig } from '../daemon/config.js';
import type { DaemonConfigShape } from '../daemon/config.js';
import {
  ConnectionClosedError,
  ControlTimeoutError,
  DaemonUnreachableError,
  mapSocketFailure as mapOpenError,
  openTimeoutMs,
} from '../daemon/control.js';
import {
  encodeClientMessage,
  LineBuffer,
  passthroughSpoolFileName,
  parseServerMessageLine,
} from '../daemon/protocol.js';
import type {
  AckMessage,
  ExitMessage,
  PassthroughSpoolRecord,
  ServerMessage,
} from '../daemon/protocol.js';

import { AnsiStreamStripper } from '../lib/ansi.js';
import { shortId } from '../lib/id.js';

import { ensureDaemonRunning, type EnsureDaemonError } from './ensure-daemon.js';
import {
  autoBackgroundExitCode,
  hostShellCapMs,
  shellCapHost,
  shouldAutoBackground,
} from './host-cap.js';
import { localQueryReason } from './local-invocation.js';
import { formatProgressLine } from './progress.js';

export interface ExecIo {
  readonly writeStderr: (data: string | Uint8Array) => void;
  readonly writeStdout: (data: Uint8Array) => void;
}

export interface RunExecOptions {
  /** Tickets that must settle before this request may start (`--after`). */
  readonly after?: readonly string[];
  readonly argv: readonly string[];
  readonly autoSpawn?: boolean;
  readonly background?: boolean;
  readonly config?: DaemonConfigShape;
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly ensureDaemon?: () => Effect.Effect<void, EnsureDaemonError>;
  readonly heartbeatMs?: number;
  readonly host?: string;
  readonly io: ExecIo;
  readonly session?: string;
  readonly silenceThresholdMs?: number;
  /**
   * The process's terminal as the generated executable envelope probed it
   * (agent-bundle#511, `main(argv, { terminal })`) — the client probes
   * nothing itself. `stdout.kind` decides whether an auto-background notice
   * must say where a redirected stdout's output went; `sharesTarget` (fd 1
   * and fd 2 name one open file: `2>&1`, `| tee`, a shared terminal) asks the
   * daemon for one merged pipe so write order survives as it would under
   * direct cargo; each channel's `color` decides whether cargo's captured
   * `always` color reaches `io` or is stripped first, so a pipe or capture
   * never sees escape bytes (demux-rendered diagnostics keep theirs on the
   * wire). Absent — a caller outside the envelope — reads as two separate
   * colorless pipes.
   */
  readonly terminal?: AgentTerminal;
  readonly workspaceRoot?: string;
}

/** `RunExecOptions` once `runExecClient` has read the terminal: what the client's internals consume. */
interface ExecOptions extends Omit<RunExecOptions, 'terminal'> {
  /** Run cargo with stderr merged into stdout: the caller's two channels share one target. */
  readonly mergeStderr: boolean;
  /** Stdout is a terminal, so an auto-background notice need not say where output went. */
  readonly stdoutIsTty: boolean;
}

export interface RunExecResult {
  readonly exitCode: number;
  readonly mode: 'brokered' | 'passthrough';
  readonly ticket?: string;
}

const defaultHeartbeatMs = 15_000;
/**
 * Heartbeats prove liveness during silent stretches; streaming output already
 * proves the brokered run is alive and should not be interrupted with noise.
 */
const silenceThresholdMs = 30_000;

/** The signals a terminal (Ctrl-C) or a `timeout N …` wrapper delivers to this client. */
type TerminationSignal = 'SIGINT' | 'SIGTERM';

const terminationSignals: readonly TerminationSignal[] = ['SIGINT', 'SIGTERM'];

/** Shell convention for a signaled exit: 128 + the signal number (130 for SIGINT, 143 for SIGTERM). */
const signalExitCode = (signal: string | null): number | null => {
  if (signal === null) {
    return null;
  }
  const number = (osConstants.signals as Readonly<Record<string, number | undefined>>)[signal];
  return number === undefined ? null : 128 + number;
};

const terminationExitCode = (signal: TerminationSignal): number => signalExitCode(signal) ?? 1;

/**
 * Resolves with the first SIGINT/SIGTERM delivered to this process. Handlers
 * are installed only while a fiber awaits this effect — resuming or
 * interrupting removes them — so Node's default (exit on signal) is back in
 * force as soon as the run is over.
 */
const awaitTerminationSignal: Effect.Effect<TerminationSignal> = Effect.callback<TerminationSignal>(
  (resume) => {
    const listeners = new Map<TerminationSignal, () => void>();
    const remove = (): void => {
      for (const [signal, listener] of listeners) {
        process.off(signal, listener);
      }
    };
    for (const signal of terminationSignals) {
      listeners.set(signal, () => {
        remove();
        resume(Effect.succeed(signal));
      });
    }
    for (const [signal, listener] of listeners) {
      process.on(signal, listener);
    }
    return Effect.sync(remove);
  },
);

const writeChannel = (io: ExecIo, channel: 'stdout' | 'stderr', data: Uint8Array): void => {
  if (channel === 'stdout') {
    io.writeStdout(data);
    return;
  }
  io.writeStderr(data);
};

/**
 * Wraps `io` so stderr output chunks are ANSI-stripped for a colorless
 * consumer. Only byte chunks (cargo output) pass through the stripper;
 * hauler's own progress strings carry no color. Stdout is left verbatim:
 * it can be program/data output (binary, caller-chosen `--message-format`
 * streams) that stripping must not touch.
 */
const withStrippedChannel = (io: ExecIo, channel: 'stdout' | 'stderr'): ExecIo => {
  const stripper = new AnsiStreamStripper();
  const forward = (write: (data: Uint8Array) => void, data: Uint8Array): void => {
    const clean = stripper.push(data);
    if (clean.byteLength > 0) {
      write(clean);
    }
  };
  if (channel === 'stdout') {
    return { writeStderr: io.writeStderr, writeStdout: (data) => forward(io.writeStdout, data) };
  }
  return {
    // hauler's own progress strings carry no color and pass through as-is.
    writeStderr: (data) => (typeof data === 'string' ? io.writeStderr(data) : forward(io.writeStderr, data)),
    writeStdout: io.writeStdout,
  };
};

export interface PassthroughMode {
  readonly reason: string;
  /**
   * Missed real work is spooled so the daemon can ingest it into cost
   * history later; local queries (help/version/metadata) are not work and
   * would only pollute that history.
   */
  readonly spool: boolean;
}

const passthrough = (
  options: ExecOptions,
  config: DaemonConfigShape,
  mode: PassthroughMode,
): Effect.Effect<RunExecResult> =>
  Effect.gen(function* () {
    const atMs = Date.now();
    options.io.writeStderr(formatProgressLine({ kind: 'passthrough', reason: mode.reason }));
    const killSignal = yield* Deferred.make<void>();
    const interruptedBy = yield* Ref.make<TerminationSignal | null>(null);
    // The child runs in its own process group (so a daemon kill reaches
    // rustc), which also means the terminal's Ctrl-C never reaches it: relay
    // the signal, or the client dies and cargo keeps the build lock. The
    // relay lives in this run's scope so its handlers go with it.
    const relay = yield* Effect.forkScoped(
      awaitTerminationSignal.pipe(
        Effect.tap((signal) => Ref.set(interruptedBy, signal)),
        Effect.andThen(Deferred.succeed(killSignal, undefined)),
      ),
    );
    const result = yield* executeCargo({
      argv: options.argv,
      cwd: options.cwd,
      env: options.env,
      killSignal,
      mergeStderr: options.mergeStderr,
      onOutput: (channel, data) => Effect.sync(() => writeChannel(options.io, channel, data)),
      tailBytes: 0,
    });
    yield* Fiber.interrupt(relay);
    if (mode.spool) {
      yield* Effect.sync(() => {
        try {
          mkdirSync(config.stateDir, { recursive: true });
          const record: PassthroughSpoolRecord = {
            version: 1,
            id: shortId(),
            kind: 'passthrough',
            atMs,
            argv: [...options.argv],
            cwd: options.cwd,
            session: options.session ?? null,
            host: options.host ?? null,
            exitCode: result.exitCode,
          };
          appendFileSync(
            join(config.stateDir, passthroughSpoolFileName),
            `${JSON.stringify(record)}\n`,
          );
        } catch {
          // Passthrough must preserve cargo's result even when the state dir is unwritable.
        }
      });
    }
    if (result.error !== null) {
      options.io.writeStderr(`[cargo-hauler] ${result.error}\n`);
    }
    const interrupted = yield* Ref.get(interruptedBy);
    return {
      exitCode:
        interrupted === null
          ? (result.exitCode ?? signalExitCode(result.signal) ?? 1)
          : terminationExitCode(interrupted),
      mode: 'passthrough' as const,
    };
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

const unreachableMode: PassthroughMode = { reason: 'daemon unreachable', spool: true };

/** How long exec keeps retrying a daemon that is up but slow to accept. */
const slowAcceptBudget = '60 seconds';

/**
 * A daemon that never accepted within the budget is alive and saturated, not
 * absent: pinging it again and running a second retry cycle would only delay
 * the build, so that failure goes straight to a direct run. Any other cause
 * (dead socket, refused) earns one spawn attempt first.
 */
export const unreachablePassthroughMode = (
  error: DaemonUnreachableError,
): PassthroughMode | null =>
  error.cause instanceof ControlTimeoutError
    ? { reason: `daemon did not accept a connection for ${slowAcceptBudget}`, spool: true }
    : null;

/** Bookkeeping for a synchronous request the client converted to a background ticket. */
interface DetachHandshake {
  /** Set once a detach was written, so the caller waits for the daemon's answer before hanging up. */
  readonly requested: Ref.Ref<boolean>;
  readonly acknowledged: Deferred.Deferred<void>;
}

/** How long to wait for `detach-result` before giving up and disconnecting anyway. */
const detachAckTimeout = '2 seconds';

/** How long to wait for the daemon to confirm a kill before hanging up on a signal. */
const killAckTimeout = '2 seconds';

/** Per-connection state the message handler and the signal relay share. */
interface StreamState {
  readonly ticket: Ref.Ref<string | null>;
  readonly phase: Ref.Ref<'queued' | 'running'>;
  readonly startedAtMs: Ref.Ref<number | null>;
  readonly lastOutputAtMs: Ref.Ref<number>;
  readonly finished: Deferred.Deferred<RunExecResult>;
  readonly handshake: DetachHandshake;
  /** Completed by the daemon's `kill-result` after this client asked to stop its ticket. */
  readonly killAcknowledged: Deferred.Deferred<void>;
  /** The signal this client received, when the run ended because of one. */
  readonly interruptedBy: Ref.Ref<TerminationSignal | null>;
  readonly detach: (ticket: string) => Effect.Effect<void>;
}

const describeExit = (message: ExitMessage): string => {
  const signal = message.signal === null ? '' : ` (${message.signal})`;
  const error = message.error === null ? '' : `: ${message.error}`;
  return `[cargo-hauler] ticket ${message.ticket} ${message.status}${signal}${error}\n`;
};

const handleServerMessage = (
  options: ExecOptions,
  message: ServerMessage,
  state: StreamState,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    switch (message.type) {
      case 'ack': {
        yield* Ref.set(state.ticket, message.ticket);
        const waitEtaMs = message.waitEtaMs ?? 0;
        // A default prior says "unknown"; showing it as a runtime would be a guess.
        const measuredEtaMs =
          message.etaMs !== undefined && message.etaSource !== undefined && message.etaSource !== 'default'
            ? message.etaMs
            : undefined;
        options.io.writeStderr(
          message.attachedTo !== undefined
            ? formatProgressLine({
                kind: 'attached',
                leaderTicket: message.attachedTo,
                mode: message.attachMode ?? 'identity',
                ticket: message.ticket,
              })
            : formatProgressLine({
                kind: 'queued',
                laneKey: message.laneKey,
                position: message.position,
                ticket: message.ticket,
                ...(message.ahead === undefined ? {} : { ahead: message.ahead }),
                ...(message.waitingFor === undefined ? {} : { waitingFor: message.waitingFor }),
                ...(measuredEtaMs === undefined ? {} : { etaMs: measuredEtaMs }),
                ...(waitEtaMs > 0 ? { waitEtaMs } : {}),
              }),
        );
        const capHost = shellCapHost(options.host, process.env);
        // What the shell tool actually waits for is the queue plus the run:
        // a five-minute build behind six minutes of queued work is killed
        // just as surely as an eleven-minute build.
        const totalEtaMs = message.etaMs === undefined ? undefined : message.etaMs + waitEtaMs;
        const autoBackground =
          options.background !== true &&
          totalEtaMs !== undefined &&
          shouldAutoBackground(totalEtaMs, capHost, message.etaSource ?? 'default');
        if (options.background === true || autoBackground) {
          options.io.writeStderr(
            formatProgressLine({
              estimateMs: autoBackground ? (totalEtaMs ?? null) : (message.etaMs ?? null),
              kind: 'background',
              ticket: message.ticket,
              ...(autoBackground && capHost !== undefined
                ? {
                    auto: {
                      capMs: hostShellCapMs(capHost),
                      host: capHost,
                      stdoutRedirected: !options.stdoutIsTty,
                    },
                  }
                : {}),
            }),
          );
          if (autoBackground) {
            // Disconnecting before the daemon reads the detach would make it
            // kill a still-queued ticket as abandoned client work.
            yield* Ref.set(state.handshake.requested, true);
            yield* state.detach(message.ticket);
          }
          yield* Deferred.succeed(state.finished, {
            exitCode: autoBackground ? autoBackgroundExitCode : 0,
            mode: 'brokered' as const,
            ticket: message.ticket,
          });
        }
        return;
      }
      case 'requeued':
        yield* Ref.set(state.phase, 'queued');
        options.io.writeStderr(
          formatProgressLine({ kind: 'requeued', reason: message.reason, ticket: message.ticket }),
        );
        return;
      case 'started':
        yield* Ref.set(state.ticket, message.ticket);
        yield* Ref.set(state.phase, 'running');
        yield* Ref.set(state.startedAtMs, Date.now());
        options.io.writeStderr(
          formatProgressLine({ kind: 'started', ticket: message.ticket, waitMs: message.waitMs }),
        );
        return;
      case 'output':
        yield* Ref.set(state.lastOutputAtMs, Date.now());
        writeChannel(options.io, message.channel, Buffer.from(message.data, 'base64'));
        return;
      case 'exit': {
        yield* Ref.set(state.ticket, message.ticket);
        // A kill, a daemon shutdown, or a spawn failure all used to reach the
        // caller as a bare exit 1 with no line to tell them apart.
        if (message.status !== 'done') {
          options.io.writeStderr(describeExit(message));
        }
        const interrupted = yield* Ref.get(state.interruptedBy);
        yield* Deferred.succeed(state.finished, {
          exitCode:
            interrupted === null
              ? (message.exitCode ?? signalExitCode(message.signal) ?? 1)
              : terminationExitCode(interrupted),
          mode: 'brokered' as const,
          ticket: message.ticket,
        });
        return;
      }
      case 'error':
        options.io.writeStderr(`[cargo-hauler] ${message.message}\n`);
        yield* Deferred.succeed(state.finished, {
          exitCode: message.code === 'bad-intent' ? 2 : 1,
          mode: 'brokered' as const,
        });
        return;
      case 'detach-result':
        if (!message.detached) {
          options.io.writeStderr(
            `[cargo-hauler] daemon did not detach ticket ${message.ticket} (not owned by this connection); it may be killed when this client exits\n`,
          );
        }
        yield* Deferred.succeed(state.handshake.acknowledged, undefined);
        return;
      case 'kill-result':
        yield* Deferred.succeed(state.killAcknowledged, undefined);
        return;
      case 'pong':
      case 'status-result':
      case 'shutting-down':
      case 'await-result':
      case 'result-result':
      case 'session-pending-result':
      case 'session-completed-result':
      case 'attempt-recorded':
        return;
      default: {
        const exhaustive: never = message;
        return exhaustive;
      }
    }
  });

const streamBrokered = (
  options: ExecOptions,
  config: DaemonConfigShape,
): Effect.Effect<
  RunExecResult,
  DaemonUnreachableError | ControlTimeoutError | ConnectionClosedError,
  Scope
> =>
  Effect.gen(function* () {
    const received: ServerMessage[] = [];
    const lines = new LineBuffer();
    const opened = yield* Deferred.make<void>();
    const finished = yield* Deferred.make<RunExecResult>();
    const ticket = yield* Ref.make<string | null>(null);
    const submittedAtMs = Date.now();
    const id = shortId();

    // v4 sockets connect lazily: open failures surface through the pump's
    // `socket.run`, which routes them via mapOpenError below.
    const socket = yield* NodeSocket.makeNet({
      openTimeout: openTimeoutMs,
      path: config.socketPath,
    });

    const write = yield* socket.writer;

    const state: StreamState = {
      detach: (target) =>
        write(encodeClientMessage({ type: 'detach', id: `${id}-detach`, ticket: target })).pipe(
          Effect.ignore,
        ),
      finished,
      handshake: {
        acknowledged: yield* Deferred.make<void>(),
        requested: yield* Ref.make(false),
      },
      interruptedBy: yield* Ref.make<TerminationSignal | null>(null),
      killAcknowledged: yield* Deferred.make<void>(),
      lastOutputAtMs: yield* Ref.make(submittedAtMs),
      phase: yield* Ref.make<'queued' | 'running'>('queued'),
      startedAtMs: yield* Ref.make<number | null>(null),
      ticket,
    };

    const afterDisconnect = (): Effect.Effect<
      RunExecResult,
      DaemonUnreachableError | ConnectionClosedError
    > =>
      Deferred.isDone(finished).pipe(
        Effect.flatMap((done) =>
          done
            ? Deferred.await(finished)
            : Effect.fail(
                new ConnectionClosedError({
                  received,
                  socketPath: config.socketPath,
                }),
              ),
        ),
      );

    const pump = socket
      .run(
        (data) =>
          Effect.gen(function* () {
            for (const line of lines.push(data)) {
              const message = parseServerMessageLine(line);
              // Output chunks are piped through, not retained: a long build
              // would otherwise accumulate its whole log (base64-inflated)
              // in this client. Disconnect recovery only needs control
              // messages (exit, ack, errors), which are small and bounded.
              if (message.type !== 'output') {
                received.push(message);
              }
              yield* handleServerMessage(options, message, state);
            }
          }),
        { onOpen: Deferred.succeed(opened, undefined).pipe(Effect.asVoid) },
      )
      .pipe(
        Effect.matchEffect({
          onFailure: (
            error,
          ): Effect.Effect<
            RunExecResult,
            DaemonUnreachableError | ControlTimeoutError | ConnectionClosedError
          > => {
            const mapped = mapOpenError(error, config.socketPath);
            switch (mapped._tag) {
              case 'DaemonUnreachable':
              case 'ControlTimeout':
                return Effect.fail(mapped);
              case 'ConnectionClosed':
                return afterDisconnect();
              default: {
                const exhaustive: never = mapped;
                return exhaustive;
              }
            }
          },
          onSuccess: () => afterDisconnect(),
        }),
      );

    const pumpFiber = yield* Effect.forkScoped(pump);
    const pumpDone = Fiber.join(pumpFiber).pipe(Effect.asVoid, Effect.ignore);

    // A foreground ticket outlives its client's disconnect (holdStop), so a
    // terminal's Ctrl-C or a `timeout` wrapper must ask the daemon to stop
    // it — and wait for the answer — before this process exits. Scoped to
    // this connection attempt: a failed open must not leave handlers behind
    // for the passthrough that follows.
    const relay = yield* Effect.forkScoped(
      awaitTerminationSignal.pipe(
        Effect.flatMap((signal) =>
          Effect.gen(function* () {
            yield* Ref.set(state.interruptedBy, signal);
            const owned = yield* Ref.get(ticket);
            if (owned === null) {
              options.io.writeStderr(`[cargo-hauler] ${signal}: giving up before the daemon answered\n`);
            } else {
              options.io.writeStderr(`[cargo-hauler] ${signal}: stopping ticket ${owned}\n`);
              yield* write(encodeClientMessage({ type: 'kill', id: `${id}-kill`, ticket: owned })).pipe(
                Effect.ignore,
              );
              yield* Deferred.await(state.killAcknowledged).pipe(
                Effect.raceFirst(pumpDone),
                Effect.timeout(killAckTimeout),
                Effect.ignore,
              );
            }
            yield* Deferred.succeed(finished, {
              exitCode: terminationExitCode(signal),
              mode: 'brokered' as const,
              ...(owned === null ? {} : { ticket: owned }),
            });
          }),
        ),
      ),
    );

    yield* Deferred.await(opened).pipe(Effect.raceFirst(Fiber.join(pumpFiber)));

    yield* write(
      encodeClientMessage({
        type: 'exec',
        id,
        argv: [...options.argv],
        cwd: options.cwd,
        ...(options.env === undefined ? {} : { env: { ...options.env } }),
        ...(options.host === undefined ? {} : { host: options.host }),
        ...(options.session === undefined ? {} : { session: options.session }),
        ...(options.workspaceRoot === undefined ? {} : { workspaceRoot: options.workspaceRoot }),
        ...(options.background === true ? { background: true } : {}),
        ...(options.mergeStderr ? { mergeStderr: true } : {}),
        ...(options.after === undefined || options.after.length === 0
          ? {}
          : { after: [...options.after] }),
      }),
    ).pipe(Effect.mapError((error) => mapOpenError(error, config.socketPath)));

    const heartbeatMs = options.heartbeatMs ?? defaultHeartbeatMs;
    const heartbeatSilenceThresholdMs = options.silenceThresholdMs ?? silenceThresholdMs;
    yield* Effect.forkScoped(
      Effect.repeat(
        Effect.gen(function* () {
          const currentTicket = yield* Ref.get(ticket);
          if (currentTicket === null) {
            return;
          }
          const now = Date.now();
          const lastOutput = yield* Ref.get(state.lastOutputAtMs);
          if (now - lastOutput < heartbeatSilenceThresholdMs) {
            return;
          }
          const currentPhase = yield* Ref.get(state.phase);
          const startedAt = yield* Ref.get(state.startedAtMs);
          // "still running (40s)" counts from the start, not from submission:
          // queue time is not run time.
          const since = currentPhase === 'running' && startedAt !== null ? startedAt : submittedAtMs;
          options.io.writeStderr(
            formatProgressLine({
              elapsedMs: now - since,
              kind: 'heartbeat',
              phase: currentPhase,
              ticket: currentTicket,
            }),
          );
        }),
        Schedule.spaced(heartbeatMs),
      ),
    );

    const result = yield* Deferred.await(finished).pipe(Effect.raceFirst(Fiber.join(pumpFiber)));
    yield* Fiber.interrupt(relay);
    if (yield* Ref.get(state.handshake.requested)) {
      const acknowledged = yield* Deferred.await(state.handshake.acknowledged).pipe(
        Effect.as(true),
        Effect.raceFirst(pumpDone.pipe(Effect.as(false))),
        Effect.timeoutOrElse({ duration: detachAckTimeout, orElse: () => Effect.succeed(false) }),
      );
      if (!acknowledged) {
        options.io.writeStderr(
          `[cargo-hauler] daemon did not confirm the detach of ticket ${result.ticket ?? '?'} within ${detachAckTimeout}; check it with hauler result\n`,
        );
      }
    }
    return result;
  });

const brokeredOrUnreachable = (
  options: ExecOptions,
  config: DaemonConfigShape,
): Effect.Effect<RunExecResult, DaemonUnreachableError> =>
  Effect.scoped(streamBrokered(options, config)).pipe(
    // The socket exists but nobody accepted within the open timeout: the
    // daemon is alive and overloaded. Running cargo directly here would put an
    // unbrokered build on an already saturated machine, so keep knocking.
    Effect.retry({
      schedule: Schedule.spaced('1 second').pipe(Schedule.upTo({ duration: slowAcceptBudget })),
      while: (error) => error._tag === 'ControlTimeout',
    }),
    Effect.catchTags({
      ConnectionClosed: (closed) => {
        const exit = closed.received.find(
          (message): message is ExitMessage => message.type === 'exit',
        );
        if (exit !== undefined) {
          return Effect.succeed({
            exitCode: exit.exitCode ?? signalExitCode(exit.signal) ?? 1,
            mode: 'brokered' as const,
            ticket: exit.ticket,
          });
        }
        if (closed.received.length === 0) {
          return Effect.fail(
            new DaemonUnreachableError({ cause: closed, socketPath: config.socketPath }),
          );
        }
        // The daemon owns a ticket for this run and will finish it without
        // us; the caller needs its id to collect the result.
        const ack = closed.received.find(
          (message): message is AckMessage => message.type === 'ack',
        );
        if (ack !== undefined) {
          options.io.writeStderr(
            `[cargo-hauler] connection to daemon lost; ticket ${ack.ticket} continues — hauler result ${ack.ticket}\n`,
          );
          return Effect.succeed({ exitCode: 1, mode: 'brokered' as const, ticket: ack.ticket });
        }
        options.io.writeStderr('[cargo-hauler] connection to daemon lost before it accepted the request\n');
        return Effect.succeed({ exitCode: 1, mode: 'brokered' as const });
      },
      ControlTimeout: (timeout) =>
        Effect.fail(new DaemonUnreachableError({ cause: timeout, socketPath: config.socketPath })),
    }),
  );

export const runExecClient = (
  rawOptions: RunExecOptions,
): Effect.Effect<RunExecResult> => {
  const { terminal, ...rest } = rawOptions;
  const stderrColor = terminal !== undefined && terminal.stderr.color !== 'none';
  const stdoutColor = terminal !== undefined && terminal.stdout.color !== 'none';
  const mergeStderr = terminal?.sharesTarget === true;
  const keep = (io: ExecIo): ExecIo => io;
  const stripStderr = stderrColor ? keep : (io: ExecIo) => withStrippedChannel(io, 'stderr');
  // A merged stream is text from both channels, so the binary-stdout caveat no longer applies.
  const stripStdout = mergeStderr && !stdoutColor ? (io: ExecIo) => withStrippedChannel(io, 'stdout') : keep;
  const options: ExecOptions = {
    ...rest,
    io: stripStdout(stripStderr(rawOptions.io)),
    mergeStderr,
    stdoutIsTty: terminal?.stdout.kind === 'tty',
  };
  const config = options.config ?? resolveDaemonConfig();
  // Help/version and other non-compiling queries never take a ticket: a
  // brokered query would hold a lane slot behind a generic multi-minute
  // estimate and record a spurious job outcome (observed with
  // `cargo hauler --help` ticketed at a ~120s ETA and counted as a
  // failed job). They run in place and stay out of the spool.
  const localReason = localQueryReason(options.argv);
  if (localReason !== null) {
    return passthrough(options, config, { reason: localReason, spool: false });
  }
  return brokeredOrUnreachable(options, config).pipe(
    Effect.catchTag('DaemonUnreachable', (unreachable) =>
      Effect.gen(function* () {
        const saturated = unreachablePassthroughMode(unreachable);
        if (saturated !== null || options.autoSpawn === false) {
          return yield* passthrough(options, config, saturated ?? unreachableMode);
        }
        const ensure = options.ensureDaemon ?? (() => ensureDaemonRunning(config).pipe(Effect.asVoid));
        yield* ensure().pipe(
          Effect.tapCause((cause) =>
            Effect.sync(() => {
              const reason = Cause.pretty(cause).split('\n')[0] ?? 'unknown error';
              options.io.writeStderr(`[cargo-hauler] daemon startup failed: ${reason}\n`);
            }),
          ),
          Effect.ignore,
        );
        return yield* brokeredOrUnreachable(options, config).pipe(
          Effect.catchTag('DaemonUnreachable', (again) =>
            passthrough(options, config, unreachablePassthroughMode(again) ?? unreachableMode),
          ),
        );
      }),
    ),
  );
};
