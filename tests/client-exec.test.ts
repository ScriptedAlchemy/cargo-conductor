import { mkdirSync, readFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { join } from 'node:path';

import { describe, expect, it } from 'effect-rstest';
import * as Effect from 'effect/Effect';
import * as Fiber from 'effect/Fiber';
import * as Schedule from 'effect/Schedule';
import type * as Scope from 'effect/Scope';

import { runExecClient, unreachablePassthroughMode } from '../src/client/exec.js';
import {
  ControlTimeoutError,
  DaemonUnreachableError,
  pingDaemon,
  requestOverSocket,
} from '../src/daemon/control.js';
import { runDaemon } from '../src/daemon/main.js';
import {
  encodeServerMessage,
  passthroughSpoolFileName,
  type AckMessage,
  type ClientMessage,
  type EstimateSource,
  type ServerMessage,
  type StatusResultMessage,
} from '../src/daemon/protocol.js';
import { LineBuffer } from '../src/lib/ndjson.js';

import { fakeCargoEnv, scopedDaemon, scopedFixture } from './harness.js';

interface ScriptedDaemonOptions {
  readonly ack: {
    readonly etaMs: number;
    readonly etaSource: EstimateSource;
    readonly waitEtaMs?: number;
  };
  /** Written right after the ack. */
  readonly after?: readonly ServerMessage[];
  /** Hang up right after the ack, as a crashing daemon would. */
  readonly closeAfterAck?: boolean;
  /** Written after the `kill-result` when the client asks to kill its ticket. */
  readonly afterKill?: readonly ServerMessage[];
}

/**
 * A stand-in daemon that acks every exec with a fixed estimate, so the
 * client's auto-background decision can be driven without teaching the real
 * cost model a nine-minute prior. Records what the client sent and answers
 * detach and kill like the real daemon does.
 */
const scriptedDaemon = (
  socketPath: string,
  options: ScriptedDaemonOptions,
): Effect.Effect<{ readonly sent: () => readonly ClientMessage[] }, never, Scope.Scope> =>
  Effect.gen(function* () {
    const sent: ClientMessage[] = [];
    const sockets = new Set<Socket>();
    yield* Effect.acquireRelease(
      Effect.callback<Server>((resume) => {
        const server = createServer((socket) => {
          sockets.add(socket);
          const lines = new LineBuffer();
          socket.on('data', (data) => {
            for (const line of lines.push(data)) {
              const message = JSON.parse(line) as ClientMessage;
              sent.push(message);
              if (message.type === 'exec') {
                const reply: AckMessage = {
                  etaMs: options.ack.etaMs,
                  etaSource: options.ack.etaSource,
                  id: message.id,
                  laneKey: 'lane',
                  position: 0,
                  ticket: 'cc-1',
                  type: 'ack',
                  ...(options.ack.waitEtaMs === undefined
                    ? {}
                    : { waitEtaMs: options.ack.waitEtaMs }),
                };
                socket.write(encodeServerMessage(reply));
                for (const next of options.after ?? []) {
                  socket.write(encodeServerMessage(next));
                }
                if (options.closeAfterAck === true) {
                  socket.end();
                }
              }
              if (message.type === 'detach') {
                socket.write(
                  encodeServerMessage({
                    detached: true,
                    id: message.id,
                    ticket: message.ticket,
                    type: 'detach-result',
                  }),
                );
              }
              if (message.type === 'kill') {
                socket.write(
                  encodeServerMessage({
                    id: message.id,
                    killed: true,
                    ticket: message.ticket,
                    type: 'kill-result',
                  }),
                );
                for (const next of options.afterKill ?? []) {
                  socket.write(encodeServerMessage(next));
                }
              }
            }
          });
        });
        server.listen(socketPath, () => resume(Effect.succeed(server)));
      }),
      (server) =>
        Effect.callback<void>((resume) => {
          for (const socket of sockets) {
            socket.destroy();
          }
          server.close(() => resume(Effect.void));
        }),
    );
    return { sent: () => sent };
  });

const waitUntil = (condition: () => boolean): Effect.Effect<void> =>
  Effect.suspend(() => (condition() ? Effect.succeed(true) : Effect.succeed(false))).pipe(
    Effect.repeat({ until: (ready) => ready, schedule: Schedule.spaced('20 millis') }),
    Effect.asVoid,
  );

const collectIo = (): {
  readonly io: {
    readonly writeStderr: (data: string | Uint8Array) => void;
    readonly writeStdout: (data: Uint8Array) => void;
  };
  readonly stderr: () => string;
  readonly stdout: () => string;
} => {
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  const toBuffer = (data: string | Uint8Array): Buffer =>
    typeof data === 'string' ? Buffer.from(data) : Buffer.from(data);
  return {
    io: {
      writeStderr: (data) => {
        stderr.push(toBuffer(data));
      },
      writeStdout: (data) => {
        stdout.push(Buffer.from(data));
      },
    },
    stderr: () => Buffer.concat(stderr).toString('utf8'),
    stdout: () => Buffer.concat(stdout).toString('utf8'),
  };
};

describe('runExecClient', () => {
  it.live('streams brokered cargo output and injects queue/start progress', () =>
    Effect.gen(function* () {
      const fixture = yield* scopedDaemon(5);
      const collected = collectIo();
      const result = yield* runExecClient({
        argv: ['cargo', 'check'],
        autoSpawn: false,
        config: fixture.config,
        cwd: fixture.ws1,
        env: fakeCargoEnv(fixture),
        io: collected.io,
      });

      expect(result.mode).toBe('brokered');
      expect(result.exitCode).toBe(0);
      expect(result.ticket).toMatch(/^cc-\d+$/u);
      expect(collected.stdout()).toContain('fake-out:check');
      expect(collected.stderr()).toContain('fake-err:check');
      expect(collected.stderr()).toMatch(/ticket cc-\d+ queued \(0 ahead/u);
      expect(collected.stderr()).toMatch(/ticket cc-\d+ started \(waited \d+ms\)/u);
    }));

  it.live('stays foreground on a cold-start default estimate, however large', () =>
    Effect.gen(function* () {
      const fixture = yield* scopedFixture(5);
      mkdirSync(fixture.config.stateDir, { recursive: true });
      const exit: ServerMessage = {
        error: null,
        exitCode: 101,
        id: 'x',
        runMs: 500,
        signal: null,
        status: 'failed',
        ticket: 'cc-1',
        type: 'exit',
        waitMs: 1,
      };
      const daemon = yield* scriptedDaemon(fixture.config.socketPath, {
        ack: { etaMs: 60 * 60_000, etaSource: 'default' },
        after: [{ id: 'x', ticket: 'cc-1', type: 'started', waitMs: 1 }, exit],
      });
      const collected = collectIo();
      const result = yield* runExecClient({
        argv: ['cargo', 'build'],
        autoSpawn: false,
        config: fixture.config,
        cwd: fixture.ws1,
        host: 'claude',
        io: collected.io,
      });

      // The compile error reaches the caller instead of a fabricated success (#37).
      expect(result).toEqual({ exitCode: 101, mode: 'brokered', ticket: 'cc-1' });
      expect(daemon.sent().map((message) => message.type)).toEqual(['exec']);
      expect(collected.stderr()).not.toContain('submitted in background');
    }));

  it.live('auto-backgrounds on a measured estimate over the host cap and exits 75', () =>
    Effect.gen(function* () {
      const fixture = yield* scopedFixture(5);
      mkdirSync(fixture.config.stateDir, { recursive: true });
      const daemon = yield* scriptedDaemon(fixture.config.socketPath, {
        ack: { etaMs: 10 * 60_000, etaSource: 'ewma' },
      });
      const collected = collectIo();
      const result = yield* runExecClient({
        argv: ['cargo', 'build'],
        autoSpawn: false,
        config: fixture.config,
        cwd: fixture.ws1,
        host: 'claude',
        io: collected.io,
      });

      // EX_TEMPFAIL: `cargo build && ./target/debug/x` must not run the binary.
      expect(result).toEqual({ exitCode: 75, mode: 'brokered', ticket: 'cc-1' });
      // The daemon must have seen the detach before the client hung up;
      // otherwise a still-queued ticket is killed as abandoned on disconnect.
      expect(daemon.sent().map((message) => message.type)).toEqual(['exec', 'detach']);
      expect(collected.stderr()).toContain('exceeds the claude shell cap');
      expect(collected.stderr()).toContain('exit 75');
    }));

  it.live('tells a caller with redirected stdout that the redirect receives no output (#68)', () =>
    Effect.gen(function* () {
      const fixture = yield* scopedFixture(5);
      mkdirSync(fixture.config.stateDir, { recursive: true });
      yield* scriptedDaemon(fixture.config.socketPath, {
        ack: { etaMs: 10 * 60_000, etaSource: 'ewma' },
      });
      const redirected = collectIo();
      const result = yield* runExecClient({
        argv: ['cargo', 'test'],
        autoSpawn: false,
        config: fixture.config,
        cwd: fixture.ws1,
        host: 'claude',
        io: redirected.io,
        stdoutIsTty: false,
      });
      expect(result.exitCode).toBe(75);
      // `cargo test > out.log` auto-backgrounded: out.log holds only this
      // notice, so it must say where the test output actually went.
      expect(redirected.stderr()).toContain(
        'your redirected stdout receives no output; read it with `hauler result cc-1 --full`',
      );

      const terminal = collectIo();
      yield* runExecClient({
        argv: ['cargo', 'test'],
        autoSpawn: false,
        config: fixture.config,
        cwd: fixture.ws1,
        host: 'claude',
        io: terminal.io,
        stdoutIsTty: true,
      });
      expect(terminal.stderr()).toContain('exceeds the claude shell cap');
      expect(terminal.stderr()).not.toContain('redirected stdout');
    }));

  it.live('counts the queue wait toward the shell cap, not just the job’s own runtime', () =>
    Effect.gen(function* () {
      const fixture = yield* scopedFixture(5);
      mkdirSync(fixture.config.stateDir, { recursive: true });
      // A five-minute build behind six minutes of queued work is the case
      // auto-background exists for: the shell would be killed at nine.
      const daemon = yield* scriptedDaemon(fixture.config.socketPath, {
        ack: { etaMs: 5 * 60_000, etaSource: 'ewma', waitEtaMs: 6 * 60_000 },
      });
      const collected = collectIo();
      const result = yield* runExecClient({
        argv: ['cargo', 'build'],
        autoSpawn: false,
        config: fixture.config,
        cwd: fixture.ws1,
        host: 'claude',
        io: collected.io,
      });

      expect(result).toEqual({ exitCode: 75, mode: 'brokered', ticket: 'cc-1' });
      expect(daemon.sent().map((message) => message.type)).toEqual(['exec', 'detach']);
      expect(collected.stderr()).toContain('queued (0 ahead, wait ~360s, run ~300s)');
      expect(collected.stderr()).toContain('exceeds the claude shell cap');
    }));

  it.live('stays foreground when wait plus runtime fits under the cap', () =>
    Effect.gen(function* () {
      const fixture = yield* scopedFixture(5);
      mkdirSync(fixture.config.stateDir, { recursive: true });
      const daemon = yield* scriptedDaemon(fixture.config.socketPath, {
        ack: { etaMs: 5 * 60_000, etaSource: 'ewma', waitEtaMs: 60_000 },
        after: [
          { id: 'x', ticket: 'cc-1', type: 'started', waitMs: 1 },
          {
            error: null,
            exitCode: 0,
            id: 'x',
            runMs: 1,
            signal: null,
            status: 'done',
            ticket: 'cc-1',
            type: 'exit',
            waitMs: 1,
          },
        ],
      });
      const collected = collectIo();
      const result = yield* runExecClient({
        argv: ['cargo', 'build'],
        autoSpawn: false,
        config: fixture.config,
        cwd: fixture.ws1,
        host: 'claude',
        io: collected.io,
      });

      expect(result).toEqual({ exitCode: 0, mode: 'brokered', ticket: 'cc-1' });
      expect(daemon.sent().map((message) => message.type)).toEqual(['exec']);
      expect(collected.stderr()).toContain('queued (0 ahead, wait ~60s, run ~300s)');
    }));

  it.live('reports the daemon’s reason when a ticket ends without an exit code', () =>
    Effect.gen(function* () {
      const fixture = yield* scopedFixture(5);
      mkdirSync(fixture.config.stateDir, { recursive: true });
      yield* scriptedDaemon(fixture.config.socketPath, {
        ack: { etaMs: 1_000, etaSource: 'default' },
        after: [
          {
            error: 'spawn failed: ENOENT /nonexistent/cargo',
            exitCode: null,
            id: 'x',
            runMs: 0,
            signal: null,
            status: 'failed',
            ticket: 'cc-1',
            type: 'exit',
            waitMs: 1,
          },
        ],
      });
      const collected = collectIo();
      const result = yield* runExecClient({
        argv: ['cargo', 'build'],
        autoSpawn: false,
        config: fixture.config,
        cwd: fixture.ws1,
        io: collected.io,
      });

      // Previously a bare exit 1 with no line: the caller could not tell a
      // compile failure from a daemon that never managed to start cargo.
      expect(result).toEqual({ exitCode: 1, mode: 'brokered', ticket: 'cc-1' });
      expect(collected.stderr()).toContain(
        '[cargo-hauler] ticket cc-1 failed: spawn failed: ENOENT /nonexistent/cargo',
      );
    }));

  it.live('maps a signaled ticket to 128 + signal and says it was killed', () =>
    Effect.gen(function* () {
      const fixture = yield* scopedFixture(5);
      mkdirSync(fixture.config.stateDir, { recursive: true });
      yield* scriptedDaemon(fixture.config.socketPath, {
        ack: { etaMs: 1_000, etaSource: 'default' },
        after: [
          {
            error: null,
            exitCode: null,
            id: 'x',
            runMs: 10,
            signal: 'SIGTERM',
            status: 'killed',
            ticket: 'cc-1',
            type: 'exit',
            waitMs: 1,
          },
        ],
      });
      const collected = collectIo();
      const result = yield* runExecClient({
        argv: ['cargo', 'build'],
        autoSpawn: false,
        config: fixture.config,
        cwd: fixture.ws1,
        io: collected.io,
      });

      expect(result).toEqual({ exitCode: 143, mode: 'brokered', ticket: 'cc-1' });
      expect(collected.stderr()).toContain('[cargo-hauler] ticket cc-1 killed (SIGTERM)');
    }));

  it.live('names the ticket when the connection drops after the ack', () =>
    Effect.gen(function* () {
      const fixture = yield* scopedFixture(5);
      mkdirSync(fixture.config.stateDir, { recursive: true });
      yield* scriptedDaemon(fixture.config.socketPath, {
        ack: { etaMs: 1_000, etaSource: 'default' },
        closeAfterAck: true,
      });
      const collected = collectIo();
      const result = yield* runExecClient({
        argv: ['cargo', 'build'],
        autoSpawn: false,
        config: fixture.config,
        cwd: fixture.ws1,
        io: collected.io,
      });

      // The ticket is still running in the daemon; the caller needs its id.
      expect(result).toEqual({ exitCode: 1, mode: 'brokered', ticket: 'cc-1' });
      expect(collected.stderr()).toContain(
        '[cargo-hauler] connection to daemon lost; ticket cc-1 continues — hauler result cc-1',
      );
    }));

  it.live('kills its own ticket and exits 130 when interrupted during a brokered run', () =>
    Effect.gen(function* () {
      const fixture = yield* scopedFixture(5);
      mkdirSync(fixture.config.stateDir, { recursive: true });
      const daemon = yield* scriptedDaemon(fixture.config.socketPath, {
        ack: { etaMs: 1_000, etaSource: 'default' },
        after: [{ id: 'x', ticket: 'cc-1', type: 'started', waitMs: 1 }],
        afterKill: [
          {
            error: null,
            exitCode: null,
            id: 'x',
            runMs: 10,
            signal: 'SIGTERM',
            status: 'killed',
            ticket: 'cc-1',
            type: 'exit',
            waitMs: 1,
          },
        ],
      });
      const collected = collectIo();
      const listenersBefore = process.listenerCount('SIGINT');
      const run = yield* Effect.forkChild(
        runExecClient({
          argv: ['cargo', 'build'],
          autoSpawn: false,
          config: fixture.config,
          cwd: fixture.ws1,
          io: collected.io,
        }),
      );
      yield* waitUntil(() => collected.stderr().includes('started'));
      expect(process.listenerCount('SIGINT')).toBe(listenersBefore + 1);
      process.emit('SIGINT');
      const result = yield* Fiber.join(run);

      // Without this the daemon keeps the ticket running (holdStop) after
      // the terminal's Ctrl-C only killed the client.
      expect(result).toEqual({ exitCode: 130, mode: 'brokered', ticket: 'cc-1' });
      expect(daemon.sent().map((message) => message.type)).toEqual(['exec', 'kill']);
      expect(collected.stderr()).toContain('SIGINT: stopping ticket cc-1');
      expect(process.listenerCount('SIGINT')).toBe(listenersBefore);
    }));

  it.live('keeps exit 0 for an explicit --bg request', () =>
    Effect.gen(function* () {
      const fixture = yield* scopedFixture(5);
      mkdirSync(fixture.config.stateDir, { recursive: true });
      yield* scriptedDaemon(fixture.config.socketPath, {
        ack: { etaMs: 1_000, etaSource: 'default' },
      });
      const collected = collectIo();
      const result = yield* runExecClient({
        argv: ['cargo', 'build'],
        autoSpawn: false,
        background: true,
        config: fixture.config,
        cwd: fixture.ws1,
        io: collected.io,
      });
      expect(result).toEqual({ exitCode: 0, mode: 'brokered', ticket: 'cc-1' });
    }));

  it.live('learns a build time from a failed run so a retry is not re-estimated cold', () =>
    Effect.gen(function* () {
      const fixture = yield* scopedDaemon(5);
      const collected = collectIo();
      const failed = yield* runExecClient({
        argv: ['cargo', 'build'],
        autoSpawn: false,
        config: fixture.config,
        cwd: fixture.ws1,
        env: fakeCargoEnv(fixture, { FAKE_EXIT: '101' }),
        io: collected.io,
      });
      expect(failed.exitCode).toBe(101);

      const messages = yield* requestOverSocket({
        isTerminal: (message) => message.type === 'exit',
        message: {
          argv: ['cargo', 'build'],
          cwd: fixture.ws1,
          env: fakeCargoEnv(fixture),
          id: 'retry',
          type: 'exec',
        },
        socketPath: fixture.config.socketPath,
        timeoutMs: 20_000,
      });
      const ack = messages.find((message): message is AckMessage => message.type === 'ack');
      expect(ack?.etaSource).toBe('ewma');
    }));

  it.live('merges the program’s stderr into stdout in write order when the caller shares one fd', () =>
    Effect.gen(function* () {
      const fixture = yield* scopedDaemon(5);
      const collected = collectIo();
      const result = yield* runExecClient({
        argv: ['cargo', 'run'],
        autoSpawn: false,
        config: fixture.config,
        cwd: fixture.ws1,
        env: fakeCargoEnv(fixture),
        io: collected.io,
        mergeStderr: true,
      });

      expect(result.exitCode).toBe(0);
      // `2>&1` on the caller's side: what cargo wrote, in the order it wrote it (#38).
      expect(collected.stdout()).toMatch(/^fake-out:run\nfake-err:run\nfake-jobs:\S+\n$/u);
      expect(collected.stderr()).not.toContain('fake-err');
    }));

  it.live('strips ANSI from a merged stream when the shared descriptor is not a color-capable TTY', () =>
    Effect.gen(function* () {
      const fixture = yield* scopedDaemon(5);
      const collected = collectIo();
      const colored = '\u001b[31mred\u001b[0m';
      const result = yield* runExecClient({
        argv: ['cargo', 'run', colored],
        autoSpawn: false,
        config: fixture.config,
        cwd: fixture.ws1,
        env: fakeCargoEnv(fixture),
        io: collected.io,
        mergeStderr: true,
        stdoutColor: false,
      });

      expect(result.exitCode).toBe(0);
      // Direct `cargo run 2>&1 | tee log` sees no color (cargo's `auto` on a
      // pipe); the merged brokered stream must not leak the captured `always`.
      expect(collected.stdout()).toContain('fake-err:run red');
      expect(collected.stdout()).not.toContain('\u001b');
    }));

  it.live('honours the merge in a passthrough run when the daemon is unreachable', () =>
    Effect.gen(function* () {
      const fixture = yield* scopedFixture(5);
      const collected = collectIo();
      const result = yield* runExecClient({
        argv: ['cargo', 'run'],
        autoSpawn: false,
        config: fixture.config,
        cwd: fixture.ws1,
        env: fakeCargoEnv(fixture),
        io: collected.io,
        mergeStderr: true,
      });

      expect(result.mode).toBe('passthrough');
      expect(collected.stdout()).toMatch(/^fake-out:run\nfake-err:run\nfake-jobs:\S+\n$/u);
    }));

  it.live('keeps channels separate for a demultiplexed build even when the caller shares one fd', () =>
    Effect.gen(function* () {
      const fixture = yield* scopedDaemon(5);
      const collected = collectIo();
      const result = yield* runExecClient({
        argv: ['cargo', 'check'],
        autoSpawn: false,
        config: fixture.config,
        cwd: fixture.ws1,
        env: fakeCargoEnv(fixture),
        io: collected.io,
        mergeStderr: true,
      });

      expect(result.exitCode).toBe(0);
      // The JSON demux owns stdout; program stderr must not be spliced into it.
      expect(collected.stderr()).toContain('fake-err:check');
    }));

  it.live('preserves a non-zero cargo exit code from the daemon', () =>
    Effect.gen(function* () {
      const fixture = yield* scopedDaemon(5);
      const collected = collectIo();
      const result = yield* runExecClient({
        argv: ['cargo', 'test'],
        autoSpawn: false,
        config: fixture.config,
        cwd: fixture.ws1,
        env: fakeCargoEnv(fixture, { FAKE_EXIT: '17' }),
        io: collected.io,
      });

      expect(result.mode).toBe('brokered');
      expect(result.exitCode).toBe(17);
    }));

  it.live('runs help/version queries in place without a ticket or a spool record', () =>
    Effect.gen(function* () {
      const fixture = yield* scopedFixture(5);
      const collected = collectIo();
      const result = yield* runExecClient({
        argv: ['cargo', 'hauler', '--help'],
        autoSpawn: false,
        config: fixture.config,
        cwd: fixture.ws1,
        env: fakeCargoEnv(fixture),
        io: collected.io,
      });

      expect(result).toEqual({ exitCode: 0, mode: 'passthrough' });
      expect(collected.stdout()).toContain('fake-out:hauler --help');
      expect(collected.stderr()).toContain('--help is a local query');
      // Local queries are not missed work: nothing is spooled for the
      // daemon to ingest into cost history.
      expect(() =>
        readFileSync(join(fixture.config.stateDir, passthroughSpoolFileName), 'utf8'),
      ).toThrow();
    }));

  it.live('falls through to a local cargo process when the daemon is unreachable', () =>
    Effect.gen(function* () {
      const fixture = yield* scopedFixture(5);
      const collected = collectIo();
      const result = yield* runExecClient({
        argv: ['cargo', 'build'],
        autoSpawn: false,
        config: fixture.config,
        cwd: fixture.ws1,
        env: fakeCargoEnv(fixture),
        io: collected.io,
      });

      expect(result).toEqual({ exitCode: 0, mode: 'passthrough' });
      expect(collected.stdout()).toContain('fake-out:build');
      expect(collected.stderr()).toContain('fake-err:build');
      expect(collected.stderr()).toContain('daemon unreachable; running cargo directly');

      const lines = readFileSync(join(fixture.config.stateDir, passthroughSpoolFileName), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(lines).toEqual([
        expect.objectContaining({
          argv: ['cargo', 'build'],
          cwd: fixture.ws1,
          exitCode: 0,
          kind: 'passthrough',
          version: 1,
        }),
      ]);

      // Started after the passthrough so it ingests the spool on boot; the
      // runner scope interrupts it before the fixture tree is removed.
      yield* Effect.forkScoped(runDaemon(fixture.config));
      yield* pingDaemon(fixture.config.socketPath, 500).pipe(
        Effect.retry(Schedule.spaced('50 millis').pipe(Schedule.upTo({ times: 100 }))),
      );
      const messages = yield* requestOverSocket({
        isTerminal: (message) => message.type === 'status-result',
        message: { id: 'passthrough-ingest', limit: 10, type: 'status' },
        socketPath: fixture.config.socketPath,
      });
      const status = messages.find(
        (message): message is StatusResultMessage => message.type === 'status-result',
      );
      expect(status?.report.recent).toEqual([
        expect.objectContaining({
          argv: ['cargo', 'build'],
          exitCode: 0,
          status: 'passthrough',
        }),
      ]);
    }));

  it.live('terminates the direct cargo run and exits 130 when interrupted in passthrough', () =>
    Effect.gen(function* () {
      const fixture = yield* scopedFixture(5);
      const collected = collectIo();
      const listenersBefore = process.listenerCount('SIGINT');
      const startedAt = Date.now();
      const run = yield* Effect.forkChild(
        runExecClient({
          argv: ['cargo', 'build'],
          autoSpawn: false,
          config: fixture.config,
          cwd: fixture.ws1,
          env: fakeCargoEnv(fixture, { FAKE_SLEEP: '20' }),
          io: collected.io,
        }),
      );
      yield* waitUntil(() => collected.stdout().includes('fake-out:build'));
      expect(process.listenerCount('SIGINT')).toBe(listenersBefore + 1);
      process.emit('SIGINT');
      const result = yield* Fiber.join(run);

      // The child is spawned detached, so without a handler Ctrl-C killed
      // only the client and left cargo (and its rustc children) running.
      expect(result).toEqual({ exitCode: 130, mode: 'passthrough' });
      expect(Date.now() - startedAt).toBeLessThan(15_000);
      expect(process.listenerCount('SIGINT')).toBe(listenersBefore);
    }));

  it.live('prints the spawn error instead of a silent exit 1 in passthrough', () =>
    Effect.gen(function* () {
      const fixture = yield* scopedFixture(5);
      const collected = collectIo();
      const result = yield* runExecClient({
        argv: ['/nonexistent/cargo-binary', 'build'],
        autoSpawn: false,
        config: fixture.config,
        cwd: fixture.ws1,
        env: fakeCargoEnv(fixture),
        io: collected.io,
      });

      expect(result).toEqual({ exitCode: 1, mode: 'passthrough' });
      expect(collected.stderr()).toMatch(/\[cargo-hauler\] .*nonexistent\/cargo-binary/u);
    }));

  it.live('carries the lane’s queue wait on the ack', () =>
    Effect.gen(function* () {
      const fixture = yield* scopedDaemon(1);
      const collected = collectIo();
      const first = yield* runExecClient({
        argv: ['cargo', 'build'],
        autoSpawn: false,
        background: true,
        config: fixture.config,
        cwd: fixture.ws1,
        env: fakeCargoEnv(fixture, { FAKE_SLEEP: '3' }),
        io: collected.io,
      });
      expect(first.ticket).toMatch(/^cc-\d+$/u);

      const messages = yield* requestOverSocket({
        isTerminal: (message) => message.type === 'ack',
        message: {
          argv: ['cargo', 'test'],
          background: true,
          cwd: fixture.ws1,
          env: fakeCargoEnv(fixture),
          id: 'second',
          type: 'exec',
        },
        socketPath: fixture.config.socketPath,
        timeoutMs: 5_000,
      });
      const ack = messages.find((message): message is AckMessage => message.type === 'ack');
      // `position` counts pending jobs only; the wait also covers the running
      // head's remaining estimate, which is what the second request sits behind.
      expect(ack?.ticket).not.toBe(first.ticket);
      expect(ack?.waitEtaMs).toBeGreaterThan(0);
    }));

  it.live('invokes ensureDaemon before falling back to passthrough', () =>
    Effect.gen(function* () {
      const fixture = yield* scopedFixture(5);
      const collected = collectIo();
      let ensured = 0;
      const result = yield* runExecClient({
        argv: ['cargo', 'check'],
        config: fixture.config,
        cwd: fixture.ws1,
        ensureDaemon: () =>
          Effect.sync(() => {
            ensured += 1;
          }),
        env: fakeCargoEnv(fixture),
        io: collected.io,
      });
      expect(ensured).toBe(1);
      expect(result.mode).toBe('passthrough');
      expect(collected.stdout()).toContain('fake-out:check');
    }));

  it.live('strips ANSI from streamed stderr when the consumer does not render color', () =>
    Effect.gen(function* () {
      const fixture = yield* scopedDaemon(5);
      const collected = collectIo();
      const colored = '\u001b[31mred\u001b[0m';
      const result = yield* runExecClient({
        argv: ['cargo', 'check', colored],
        autoSpawn: false,
        config: fixture.config,
        cwd: fixture.ws1,
        env: fakeCargoEnv(fixture),
        io: collected.io,
        stderrColor: false,
      });

      expect(result.exitCode).toBe(0);
      expect(collected.stderr()).toContain('fake-err:check red');
      expect(collected.stderr()).not.toContain('\u001b');
      // Stdout may be program/data output; it is never rewritten.
      expect(collected.stdout()).toContain(colored);
    }));

  it.live('passes ANSI through on stderr for a color-capable consumer', () =>
    Effect.gen(function* () {
      const fixture = yield* scopedDaemon(5);
      const collected = collectIo();
      const colored = '\u001b[31mred\u001b[0m';
      const result = yield* runExecClient({
        argv: ['cargo', 'check', colored],
        autoSpawn: false,
        config: fixture.config,
        cwd: fixture.ws1,
        env: fakeCargoEnv(fixture),
        io: collected.io,
        stderrColor: true,
      });

      expect(result.exitCode).toBe(0);
      expect(collected.stderr()).toContain(`fake-err:check ${colored}`);
    }));

  it.live('suppresses heartbeat progress while brokered output keeps streaming', () =>
    Effect.gen(function* () {
      const fixture = yield* scopedDaemon(5);
      const collected = collectIo();
      const result = yield* runExecClient({
        argv: ['cargo', 'check'],
        autoSpawn: false,
        config: fixture.config,
        cwd: fixture.ws1,
        env: fakeCargoEnv(fixture, {
          FAKE_OUTPUT_COUNT: '8',
          FAKE_OUTPUT_INTERVAL: '0.04',
        }),
        heartbeatMs: 30,
        io: collected.io,
      });

      expect(result.mode).toBe('brokered');
      expect(result.exitCode).toBe(0);
      expect(collected.stdout()).toContain('fake-tick:7');
      expect(collected.stderr()).not.toContain('still running');
    }));

  it.live('emits heartbeat progress after brokered output becomes silent', () =>
    Effect.gen(function* () {
      const fixture = yield* scopedDaemon(5);
      const collected = collectIo();
      const result = yield* runExecClient({
        argv: ['cargo', 'check'],
        autoSpawn: false,
        config: fixture.config,
        cwd: fixture.ws1,
        env: fakeCargoEnv(fixture, { FAKE_SLEEP: '0.35' }),
        heartbeatMs: 80,
        io: collected.io,
        silenceThresholdMs: 120,
      });

      expect(result.mode).toBe('brokered');
      expect(result.exitCode).toBe(0);
      expect(collected.stderr()).toMatch(/still running \(\d+s\)/u);
    }));
});

describe('unreachablePassthroughMode', () => {
  it('goes straight to cargo when the daemon is alive but never accepted', () => {
    // After 60 s of knocking, pinging again and running a second 60 s cycle
    // only delays the build; a saturated daemon is not an absent one.
    const saturated = new DaemonUnreachableError({
      cause: new ControlTimeoutError({
        phase: 'open',
        received: [],
        socketPath: '/s',
        timeoutMs: 2_000,
      }),
      socketPath: '/s',
    });
    expect(unreachablePassthroughMode(saturated)).toEqual({
      reason: 'daemon did not accept a connection for 60 seconds',
      spool: true,
    });
    // A dead socket still deserves a spawn attempt first.
    expect(
      unreachablePassthroughMode(
        new DaemonUnreachableError({ cause: new Error('ECONNREFUSED'), socketPath: '/s' }),
      ),
    ).toBeNull();
  });
});
