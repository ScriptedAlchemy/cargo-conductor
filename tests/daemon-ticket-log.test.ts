import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'effect-rstest';
import * as Effect from 'effect/Effect';
import * as Fiber from 'effect/Fiber';
import * as Schedule from 'effect/Schedule';
import type * as Scope from 'effect/Scope';

import type { DaemonConfigShape } from '../src/daemon/config.js';
import { pingDaemon } from '../src/daemon/control.js';
import { runDaemon } from '../src/daemon/main.js';
import type { AckMessage } from '../src/daemon/protocol.js';
import { ticketLogPath } from '../src/daemon/ticket-log.js';

import {
  decodeOutput,
  execRequest,
  findExit,
  pollReport,
  scopedDaemon,
  scopedFixture,
  scopedLedger,
} from './harness.js';
import type { Fixture } from './harness.js';

/** Like `scopedDaemon`, but with config overrides applied before the daemon boots. */
const scopedDaemonWith = (
  overrides: (config: DaemonConfigShape) => DaemonConfigShape,
): Effect.Effect<Fixture, unknown, Scope.Scope> =>
  Effect.gen(function* () {
    const base = yield* scopedFixture(5);
    const fixture: Fixture = { ...base, config: overrides(base.config) };
    yield* Effect.forkScoped(runDaemon(fixture.config));
    yield* pingDaemon(fixture.config.socketPath, 500).pipe(
      Effect.retry(Schedule.spaced('50 millis').pipe(Schedule.upTo({ times: 100 }))),
    );
    return fixture;
  });

const stagedCargoScript = `#!/usr/bin/env bash
while IFS= read -r line; do
  case "$line" in
    sleep:*) sleep "\${line#sleep:}" ;;
    stderr:*) echo "\${line#stderr:}" >&2 ;;
    exit:*) exit "\${line#exit:}" ;;
    *) printf '%s\\n' "$line" ;;
  esac
done < "$FAKE_STAGE_FILE"
exit 0
`;

const stagedCargo = (
  fixture: Fixture,
  stages: readonly string[],
): { readonly cargoPath: string; readonly extraEnv: Record<string, string> } => {
  const dir = join(fixture.root, 'staged');
  mkdirSync(dir, { recursive: true });
  const cargoPath = join(dir, 'cargo');
  writeFileSync(cargoPath, stagedCargoScript);
  chmodSync(cargoPath, 0o755);
  const stageFile = join(dir, 'stages.txt');
  writeFileSync(stageFile, `${stages.join('\n')}\n`);
  return { cargoPath, extraEnv: { FAKE_STAGE_FILE: stageFile } };
};

describe('per-ticket output logs (#68)', () => {
  it.live('writes every leader output chunk to <stateDir>/tickets/<ticket>.log and records the path', () =>
    Effect.gen(function* () {
      const fixture = yield* scopedDaemon(5);
      const messages = yield* execRequest(fixture, {
        argv: ['cargo', 'run'],
        cwd: fixture.ws1,
        extraEnv: { FAKE_OUTPUT_COUNT: '3', FAKE_OUTPUT_INTERVAL: '0.01' },
      });
      const exit = findExit(messages);
      expect(exit.status).toBe('done');

      const expectedPath = ticketLogPath(fixture.config.ticketLogDir, exit.ticket);
      const report = yield* pollReport(fixture, (candidate) =>
        candidate.recent.some((record) => record.ticket === exit.ticket),
      );
      const record = report.recent.find((candidate) => candidate.ticket === exit.ticket);
      expect(record?.outputPath).toBe(expectedPath);

      // The file is the run's combined output as the broker emitted it — the
      // same bytes the streaming caller saw, nothing dropped to a tail bound.
      const log = readFileSync(expectedPath, 'utf8');
      expect(log).toContain('fake-out:run');
      expect(log).toContain('fake-err:run');
      expect(log).toContain('fake-tick:0');
      expect(log).toContain('fake-tick:2');
      const streamed = decodeOutput(messages, 'stdout') + decodeOutput(messages, 'stderr');
      expect(log.length).toBe(streamed.length);
      // The ledger row still carries only the bounded tail.
      const ledger = yield* scopedLedger(fixture.config);
      const durable = yield* ledger.getRequestByTicket(exit.ticket);
      expect(durable?.outputPath).toBe(expectedPath);
      expect(durable?.outputTail).toContain('fake-tick:2');
    }));

  it.live('records the leader log path for an attached follower', () =>
    Effect.gen(function* () {
      const fixture = yield* scopedDaemon(5);
      const leaderFiber = yield* Effect.forkChild(
        execRequest(fixture, { argv: ['cargo', 'test'], cwd: fixture.ws1, sleep: '1.5', timeoutMs: 15_000 }),
      );
      yield* pollReport(fixture, (report) =>
        report.active.some((record) => record.status === 'running'),
      );
      const followerMessages = yield* execRequest(fixture, {
        argv: ['cargo', 'test'],
        cwd: fixture.ws1,
        sleep: '1.5',
        timeoutMs: 15_000,
      });
      const followerAck = followerMessages.find(
        (message): message is AckMessage => message.type === 'ack',
      );
      expect(followerAck?.attachedTo).toBeDefined();
      const followerExit = findExit(followerMessages);
      const leaderExit = findExit(yield* Fiber.join(leaderFiber));
      expect(followerExit.ticket).not.toBe(leaderExit.ticket);

      const ledger = yield* scopedLedger(fixture.config);
      const leader = yield* ledger.getRequestByTicket(leaderExit.ticket);
      const follower = yield* ledger.getRequestByTicket(followerExit.ticket);
      expect(leader?.outputPath).toBe(ticketLogPath(fixture.config.ticketLogDir, leaderExit.ticket));
      expect(follower?.attachedTo).toBe(leaderExit.ticket);
      expect(follower?.outputPath).toBe(leader?.outputPath);
      expect(existsSync(ticketLogPath(fixture.config.ticketLogDir, followerExit.ticket))).toBe(false);
    }));

  it.live('logs the rendered diagnostics of a demultiplexed run, not the raw JSON stream', () =>
    Effect.gen(function* () {
      const fixture = yield* scopedDaemon(5);
      const staged = stagedCargo(fixture, [
        'stderr:   Compiling aa v0.1.0',
        JSON.stringify({
          reason: 'compiler-message',
          package_id: 'path+file:///fx#aa@0.1.0',
          target: { kind: ['lib'], name: 'aa' },
          message: { rendered: 'error[E0999]: aa broke\n', level: 'error' },
        }),
        'plain stdout line from a test binary',
        '{"reason":"build-finished","success":false}',
        'exit:101',
      ]);
      const messages = yield* execRequest(fixture, {
        argv: [staged.cargoPath, 'check', '-p', 'aa'],
        cwd: fixture.ws1,
        extraEnv: staged.extraEnv,
        timeoutMs: 15_000,
      });
      const exit = findExit(messages);
      expect(exit.status).toBe('failed');
      const log = readFileSync(ticketLogPath(fixture.config.ticketLogDir, exit.ticket), 'utf8');
      expect(log).toContain('   Compiling aa v0.1.0');
      expect(log).toContain('error[E0999]: aa broke');
      expect(log).toContain('plain stdout line from a test binary');
      expect(log).not.toContain('compiler-message');
      expect(log).not.toContain('build-finished');
    }));

  it.live('stops at CARGO_HAULER_TICKET_LOG_MAX_BYTES with a final truncation line', () =>
    Effect.gen(function* () {
      const fixture = yield* scopedDaemonWith((config) => ({ ...config, ticketLogMaxBytes: 40 }));
      const messages = yield* execRequest(fixture, {
        argv: ['cargo', 'run'],
        cwd: fixture.ws1,
        extraEnv: { FAKE_OUTPUT_COUNT: '20', FAKE_OUTPUT_INTERVAL: '0.005' },
      });
      const exit = findExit(messages);
      const log = readFileSync(ticketLogPath(fixture.config.ticketLogDir, exit.ticket), 'utf8');
      expect(log).toContain('fake-out:run');
      expect(log).not.toContain('fake-tick:19');
      expect(log.trimEnd().split('\n').at(-1)).toContain(
        'output log truncated at 40 bytes (CARGO_HAULER_TICKET_LOG_MAX_BYTES)',
      );
    }));

  it.live('writes no log and records no path when the bound is 0', () =>
    Effect.gen(function* () {
      const fixture = yield* scopedDaemonWith((config) => ({ ...config, ticketLogMaxBytes: 0 }));
      const messages = yield* execRequest(fixture, { argv: ['cargo', 'run'], cwd: fixture.ws1 });
      const exit = findExit(messages);
      expect(exit.status).toBe('done');
      const ledger = yield* scopedLedger(fixture.config);
      expect((yield* ledger.getRequestByTicket(exit.ticket))?.outputPath).toBeNull();
      expect(existsSync(ticketLogPath(fixture.config.ticketLogDir, exit.ticket))).toBe(false);
    }));

  it.live('removes logs without a ledger row at startup and keeps the ones with a row', () =>
    Effect.gen(function* () {
      const fixture = yield* scopedFixture(5);
      const ledger = yield* scopedLedger(fixture.config);
      const kept = yield* ledger.createRequest({
        argv: ['cargo', 'check'],
        createdAtMs: Date.now(),
        cwd: fixture.ws1,
        host: 'test',
        intentJson: null,
        intentKey: null,
        laneKey: 'lane',
        session: null,
        targetDir: join(fixture.ws1, 'target'),
        workspaceRoot: fixture.ws1,
      });
      yield* ledger.markFinished(kept.id, { atMs: Date.now(), exitCode: 0, status: 'done' });
      mkdirSync(fixture.config.ticketLogDir, { recursive: true });
      const keptLog = ticketLogPath(fixture.config.ticketLogDir, kept.ticket);
      const orphanLog = ticketLogPath(fixture.config.ticketLogDir, 'cc-4242');
      writeFileSync(keptLog, 'kept\n');
      writeFileSync(orphanLog, 'orphan\n');

      yield* Effect.forkScoped(runDaemon(fixture.config));
      yield* pingDaemon(fixture.config.socketPath, 500).pipe(
        Effect.retry(Schedule.spaced('50 millis').pipe(Schedule.upTo({ times: 100 }))),
      );
      expect(existsSync(keptLog)).toBe(true);
      expect(existsSync(orphanLog)).toBe(false);
    }));
});
