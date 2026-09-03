import { mkdirSync, readFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { join } from 'node:path';

import { describe, expect, it } from 'effect-rstest';
import * as Effect from 'effect/Effect';
import * as Schedule from 'effect/Schedule';
import type * as Scope from 'effect/Scope';

import { runExecClient } from '../src/client/exec.js';
import { pingDaemon, requestOverSocket } from '../src/daemon/control.js';
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

/**
 * A stand-in daemon that acks every exec with a fixed estimate, so the
 * client's auto-background decision can be driven without teaching the real
 * cost model a nine-minute prior. Records what the client sent and answers a
 * detach like the real daemon does.
 */
const scriptedDaemon = (
  socketPath: string,
  ack: { readonly etaMs: number; readonly etaSource: EstimateSource },
  after: readonly ServerMessage[],
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
                  etaMs: ack.etaMs,
                  etaSource: ack.etaSource,
                  id: message.id,
                  laneKey: 'lane',
                  position: 0,
                  ticket: 'cc-1',
                  type: 'ack',
                };
                socket.write(encodeServerMessage(reply));
                for (const next of after) {
                  socket.write(encodeServerMessage(next));
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
      const daemon = yield* scriptedDaemon(
        fixture.config.socketPath,
        { etaMs: 60 * 60_000, etaSource: 'default' },
        [{ id: 'x', ticket: 'cc-1', type: 'started', waitMs: 1 }, exit],
      );
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
      const daemon = yield* scriptedDaemon(
        fixture.config.socketPath,
        { etaMs: 10 * 60_000, etaSource: 'ewma' },
        [],
      );
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

  it.live('keeps exit 0 for an explicit --bg request', () =>
    Effect.gen(function* () {
      const fixture = yield* scopedFixture(5);
      mkdirSync(fixture.config.stateDir, { recursive: true });
      yield* scriptedDaemon(
        fixture.config.socketPath,
        { etaMs: 1_000, etaSource: 'default' },
        [],
      );
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
