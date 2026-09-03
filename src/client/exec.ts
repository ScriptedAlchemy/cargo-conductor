import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import * as NodeServices from '@effect/platform-node/NodeServices';
import * as NodeSocket from '@effect/platform-node/NodeSocket';
import * as Cause from 'effect/Cause';
import * as Deferred from 'effect/Deferred';
import * as Effect from 'effect/Effect';
import * as Fiber from 'effect/Fiber';
import * as Ref from 'effect/Ref';
import * as Schedule from 'effect/Schedule';
import type { Scope } from 'effect/Scope';
import * as Socket from 'effect/unstable/socket/Socket';

import { executeCargo } from '../daemon/executor.js';
import { resolveDaemonConfig } from '../daemon/config.js';
import type { DaemonConfigShape } from '../daemon/config.js';
import {
  ConnectionClosedError,
  type ControlTimeoutError,
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
  ExitMessage,
  PassthroughSpoolRecord,
  ServerMessage,
} from '../daemon/protocol.js';

import { AnsiStreamStripper, colorEnabled } from '../lib/ansi.js';
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
import { sharesOutputTarget } from './shared-output.js';

export interface ExecIo {
  readonly writeStderr: (data: string | Uint8Array) => void;
  readonly writeStdout: (data: Uint8Array) => void;
}

export interface RunExecOptions {
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
  /**
   * Ask the daemon to run cargo with stderr merged into stdout. Defaults to
   * whether this process's fd 1 and fd 2 are the same open file (`2>&1`), in
   * which case direct cargo would have preserved write order across them.
   */
  readonly mergeStderr?: boolean;
  readonly session?: string;
  readonly silenceThresholdMs?: number;
  /**
   * Whether the consumer of stderr renders ANSI color. When false, cargo
   * output chunks (demux-rendered diagnostics keep their color on the wire)
   * are stripped before reaching `io`, so a pipe/capture never sees escape
   * bytes. Defaults to this process's stderr TTY-ness combined with the
   * NO_COLOR/FORCE_COLOR/CLICOLOR/TERM conventions.
   */
  readonly stderrColor?: boolean;
  readonly workspaceRoot?: string;
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
const withStrippedStderr = (io: ExecIo): ExecIo => {
  const stripper = new AnsiStreamStripper();
  return {
    writeStderr: (data) => {
      if (typeof data === 'string') {
        io.writeStderr(data);
        return;
      }
      const stripped = stripper.push(data);
      if (stripped.byteLength > 0) {
        io.writeStderr(stripped);
      }
    },
    writeStdout: io.writeStdout,
  };
};

interface PassthroughMode {
  readonly reason: string;
  /**
   * Missed real work is spooled so the daemon can ingest it into cost
   * history later; local queries (help/version/metadata) are not work and
   * would only pollute that history.
   */
  readonly spool: boolean;
}

const passthrough = (
  options: RunExecOptions,
  config: DaemonConfigShape,
  mode: PassthroughMode,
): Effect.Effect<RunExecResult> =>
  Effect.gen(function* () {
    const atMs = Date.now();
    options.io.writeStderr(formatProgressLine({ kind: 'passthrough', reason: mode.reason }));
    const killSignal = yield* Deferred.make<void>();
    const result = yield* executeCargo({
      argv: options.argv,
      cwd: options.cwd,
      env: options.env,
      killSignal,
      onOutput: (channel, data) => Effect.sync(() => writeChannel(options.io, channel, data)),
      tailBytes: 0,
    });
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
    return {
      exitCode: result.exitCode ?? 1,
      mode: 'passthrough' as const,
    };
  }).pipe(Effect.provide(NodeServices.layer));

const unreachableMode: PassthroughMode = { reason: 'daemon unreachable', spool: true };

/** Bookkeeping for a synchronous request the client converted to a background ticket. */
interface DetachHandshake {
  /** Set once a detach was written, so the caller waits for the daemon's answer before hanging up. */
  readonly requested: Ref.Ref<boolean>;
  readonly acknowledged: Deferred.Deferred<void>;
}

/** How long to wait for `detach-result` before giving up and disconnecting anyway. */
const detachAckTimeout = '2 seconds';

const handleServerMessage = (
  options: RunExecOptions,
  message: ServerMessage,
  ticket: Ref.Ref<string | null>,
  phase: Ref.Ref<'queued' | 'running'>,
  lastOutputAtMs: Ref.Ref<number>,
  finished: Deferred.Deferred<RunExecResult>,
  detach: (ticket: string) => Effect.Effect<void>,
  handshake: DetachHandshake,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    switch (message.type) {
      case 'ack':
        yield* Ref.set(ticket, message.ticket);
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
                ...(message.etaMs === undefined ? {} : { etaMs: message.etaMs }),
              }),
        );
        const capHost = shellCapHost(options.host, process.env);
        const autoBackground =
          options.background !== true &&
          message.etaMs !== undefined &&
          shouldAutoBackground(message.etaMs, capHost, message.etaSource ?? 'default');
        if (options.background === true || autoBackground) {
          options.io.writeStderr(
            formatProgressLine({
              estimateMs: message.etaMs ?? null,
              kind: 'background',
              ticket: message.ticket,
              ...(autoBackground && capHost !== undefined
                ? { auto: { capMs: hostShellCapMs(capHost), host: capHost } }
                : {}),
            }),
          );
          if (autoBackground) {
            // Disconnecting before the daemon reads the detach would make it
            // kill a still-queued ticket as abandoned client work.
            yield* Ref.set(handshake.requested, true);
            yield* detach(message.ticket);
          }
          yield* Deferred.succeed(finished, {
            exitCode: autoBackground ? autoBackgroundExitCode : 0,
            mode: 'brokered' as const,
            ticket: message.ticket,
          });
        }
        return;
      case 'requeued':
        yield* Ref.set(phase, 'queued');
        options.io.writeStderr(
          formatProgressLine({ kind: 'requeued', reason: message.reason, ticket: message.ticket }),
        );
        return;
      case 'started':
        yield* Ref.set(ticket, message.ticket);
        yield* Ref.set(phase, 'running');
        options.io.writeStderr(
          formatProgressLine({ kind: 'started', ticket: message.ticket, waitMs: message.waitMs }),
        );
        return;
      case 'output':
        yield* Ref.set(lastOutputAtMs, Date.now());
        writeChannel(options.io, message.channel, Buffer.from(message.data, 'base64'));
        return;
      case 'exit':
        yield* Ref.set(ticket, message.ticket);
        yield* Deferred.succeed(finished, {
          exitCode: message.exitCode === null ? 1 : message.exitCode,
          mode: 'brokered' as const,
          ticket: message.ticket,
        });
        return;
      case 'error':
        options.io.writeStderr(`[cargo-hauler] ${message.message}\n`);
        yield* Deferred.succeed(finished, {
          exitCode: message.code === 'bad-intent' ? 2 : 1,
          mode: 'brokered' as const,
        });
        return;
      case 'detach-result':
        yield* Deferred.succeed(handshake.acknowledged, undefined);
        return;
      case 'kill-result':
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
  options: RunExecOptions,
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
    const phase = yield* Ref.make<'queued' | 'running'>('queued');
    const submittedAtMs = Date.now();
    const lastOutputAtMs = yield* Ref.make(submittedAtMs);
    const id = shortId();
    const handshake: DetachHandshake = {
      acknowledged: yield* Deferred.make<void>(),
      requested: yield* Ref.make(false),
    };

    // v4 sockets connect lazily: open failures surface through the pump's
    // `socket.run`, which routes them via mapOpenError below.
    const socket = yield* NodeSocket.makeNet({
      openTimeout: openTimeoutMs,
      path: config.socketPath,
    });

    const write = yield* socket.writer;

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
              yield* handleServerMessage(
                options,
                message,
                ticket,
                phase,
                lastOutputAtMs,
                finished,
                (target) =>
                  write(
                    encodeClientMessage({ type: 'detach', id: `${id}-detach`, ticket: target }),
                  ).pipe(Effect.ignore),
                handshake,
              );
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
        ...((options.mergeStderr ?? sharesOutputTarget(1, 2)) ? { mergeStderr: true } : {}),
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
          const lastOutput = yield* Ref.get(lastOutputAtMs);
          if (now - lastOutput < heartbeatSilenceThresholdMs) {
            return;
          }
          const currentPhase = yield* Ref.get(phase);
          options.io.writeStderr(
            formatProgressLine({
              elapsedMs: now - submittedAtMs,
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
    if (yield* Ref.get(handshake.requested)) {
      yield* Deferred.await(handshake.acknowledged).pipe(
        Effect.raceFirst(Fiber.join(pumpFiber).pipe(Effect.asVoid)),
        Effect.timeout(detachAckTimeout),
        Effect.ignore,
      );
    }
    return result;
  });

/** How long exec keeps retrying a daemon that is up but slow to accept. */
const slowAcceptBudget = '60 seconds';

const brokeredOrUnreachable = (
  options: RunExecOptions,
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
    Effect.tapError((error) =>
      error._tag === 'ControlTimeout'
        ? Effect.sync(() => {
            options.io.writeStderr(
              `[cargo-hauler] daemon did not accept a connection for ${slowAcceptBudget}; trying cargo directly\n`,
            );
          })
        : Effect.void,
    ),
    Effect.catchTags({
      ConnectionClosed: (closed) => {
        const exit = closed.received.find(
          (message): message is ExitMessage => message.type === 'exit',
        );
        if (exit !== undefined) {
          return Effect.succeed({
            exitCode: exit.exitCode === null ? 1 : exit.exitCode,
            mode: 'brokered' as const,
            ticket: exit.ticket,
          });
        }
        if (closed.received.length === 0) {
          return Effect.fail(
            new DaemonUnreachableError({ cause: closed, socketPath: config.socketPath }),
          );
        }
        return Effect.succeed({ exitCode: 1, mode: 'brokered' as const });
      },
      ControlTimeout: (timeout) =>
        Effect.fail(new DaemonUnreachableError({ cause: timeout, socketPath: config.socketPath })),
    }),
  );

export const runExecClient = (
  rawOptions: RunExecOptions,
): Effect.Effect<RunExecResult> => {
  const stderrColor =
    rawOptions.stderrColor ?? colorEnabled(process.env, process.stderr.isTTY === true);
  const options: RunExecOptions = stderrColor
    ? rawOptions
    : { ...rawOptions, io: withStrippedStderr(rawOptions.io) };
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
    Effect.catchTag('DaemonUnreachable', () =>
      Effect.gen(function* () {
        if (options.autoSpawn === false) {
          return yield* passthrough(options, config, unreachableMode);
        }
        const ensure = options.ensureDaemon ?? (() => ensureDaemonRunning(config).pipe(Effect.asVoid));
        yield* ensure().pipe(
          Effect.tapCause((cause) =>
            Effect.sync(() => {
              const reason = Cause.pretty(cause).split('\n')[0] ?? 'unknown error';
              options.io.writeStderr(
                `[cargo-hauler] daemon startup failed: ${reason}; trying cargo directly\n`,
              );
            }),
          ),
          Effect.ignore,
        );
        return yield* brokeredOrUnreachable(options, config).pipe(
          Effect.catchTag('DaemonUnreachable', () => passthrough(options, config, unreachableMode)),
        );
      }),
    ),
  );
};
