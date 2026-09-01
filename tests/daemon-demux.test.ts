import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from '@rstest/core';
import * as Effect from 'effect/Effect';
import * as Fiber from 'effect/Fiber';

import { createLedgerApi, openLedgerDatabase } from '../src/daemon/ledger.js';
import { defaultTicketOperations } from '../src/operations/tickets.js';
import { decodeOutput, execRequest, findExit, pollReport, withDaemon } from './harness.js';
import type { Fixture } from './harness.js';

const restoreEnv = (name: string, value: string | undefined): void => {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
};

/**
 * A staged fake cargo: executes FAKE_STAGE_FILE line by line — `sleep:N`,
 * `stderr:text`, `exit:N`, anything else is echoed to stdout verbatim.
 * Used to emit realistic `--message-format=json` streams on a schedule.
 */
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

const artifactLine = (name: string, kind = 'lib'): string =>
  JSON.stringify({
    reason: 'compiler-artifact',
    package_id: `path+file:///fx#${name}@0.1.0`,
    target: { kind: [kind], name },
    fresh: false,
  });

const errorLine = (name: string, rendered: string, kind = 'lib'): string =>
  JSON.stringify({
    reason: 'compiler-message',
    package_id: `path+file:///fx#${name}@0.1.0`,
    target: { kind: [kind], name },
    message: { rendered: `${rendered}\n`, level: 'error' },
  });

const warningLine = (name: string, rendered: string, kind = 'lib'): string =>
  JSON.stringify({
    reason: 'compiler-message',
    package_id: `path+file:///fx#${name}@0.1.0`,
    target: { kind: [kind], name },
    message: { rendered: `${rendered}\n`, level: 'warning' },
  });

let stageCounter = 0;

const stagedCargo = (
  fixture: Fixture,
  stages: readonly string[],
): { readonly cargoPath: string; readonly extraEnv: Record<string, string> } => {
  stageCounter += 1;
  const dir = join(fixture.root, `staged-${stageCounter}`);
  mkdirSync(dir, { recursive: true });
  const cargoPath = join(dir, 'cargo');
  writeFileSync(cargoPath, stagedCargoScript);
  chmodSync(cargoPath, 0o755);
  const stageFile = join(dir, 'stages.txt');
  writeFileSync(stageFile, `${stages.join('\n')}\n`);
  return { cargoPath, extraEnv: { FAKE_STAGE_FILE: stageFile } };
};

describe('json demux early release', () => {
  it('persists diagnostic counts per leader and follower package scope', () =>
    withDaemon(5, (fixture) =>
      Effect.gen(function* () {
        const staged = stagedCargo(fixture, [
          'sleep:0.4',
          warningLine('aa', 'warning: aa is deprecated'),
          artifactLine('aa'),
          'sleep:0.4',
          errorLine('bb', 'error[E0999]: bb broke'),
          '{"reason":"build-finished","success":false}',
          'exit:101',
        ]);
        const leaderFiber = yield* Effect.forkChild(
          execRequest(fixture, {
            cwd: fixture.ws1,
            argv: [staged.cargoPath, 'check', '-p', 'aa', '-p', 'bb'],
            extraEnv: staged.extraEnv,
            timeoutMs: 15_000,
          }),
        );
        yield* pollReport(fixture, (report) =>
          report.active.some((record) => record.status === 'running'),
        );

        const followerMessages = yield* execRequest(fixture, {
          cwd: fixture.ws1,
          argv: [staged.cargoPath, 'check', '-p', 'aa', '--lib'],
          extraEnv: staged.extraEnv,
          timeoutMs: 15_000,
        });
        const followerExit = findExit(followerMessages);
        expect(followerExit.status).toBe('done');
        const leaderExit = findExit(yield* Fiber.join(leaderFiber));
        expect(leaderExit.status).toBe('failed');

        const report = yield* pollReport(fixture, (candidate) =>
          candidate.recent.some((record) => record.ticket === leaderExit.ticket),
        );
        const follower = report.recent.find(
          (record) => record.ticket === followerExit.ticket,
        );
        const leader = report.recent.find((record) => record.ticket === leaderExit.ticket);
        expect(follower).toEqual(
          expect.objectContaining({
            diagnostics: ['warning: aa is deprecated\n'],
            errorCount: 0,
            warningCount: 1,
          }),
        );
        expect(leader).toEqual(
          expect.objectContaining({
            diagnostics: ['warning: aa is deprecated\n', 'error[E0999]: bb broke\n'],
            errorCount: 1,
            warningCount: 1,
          }),
        );
      }),
    ));

  it('releases a --lib coverage waiter as soon as its packages compile, before the leader finishes', () =>
    withDaemon(5, (fixture) =>
      Effect.gen(function* () {
        const staged = stagedCargo(fixture, [
          'sleep:0.4',
          artifactLine('aa'),
          'sleep:1.2',
          artifactLine('bb'),
          '{"reason":"build-finished","success":true}',
          'exit:0',
        ]);
        const leaderFiber = yield* Effect.forkChild(
          execRequest(fixture, {
            cwd: fixture.ws1,
            argv: [staged.cargoPath, 'check', '-p', 'aa', '-p', 'bb'],
            extraEnv: staged.extraEnv,
            timeoutMs: 15_000,
          }),
        );
        yield* pollReport(fixture, (report) =>
          report.active.some((record) => record.status === 'running'),
        );

        const followerMessages = yield* execRequest(fixture, {
          cwd: fixture.ws1,
          argv: [staged.cargoPath, 'check', '-p', 'aa', '--lib'],
          extraEnv: staged.extraEnv,
          timeoutMs: 15_000,
        });
        const followerDoneAtMs = Date.now();
        const followerExit = findExit(followerMessages);
        expect(followerExit.status).toBe('done');
        expect(followerExit.exitCode).toBe(0);
        expect(decodeOutput(followerMessages, 'stderr')).toContain('released early');

        const leaderMessages = yield* Fiber.join(leaderFiber);
        const leaderDoneAtMs = Date.now();
        expect(findExit(leaderMessages).status).toBe('done');
        // The waiter was released while the leader was still compiling bb.
        expect(leaderDoneAtMs - followerDoneAtMs).toBeGreaterThanOrEqual(400);
      }),
    ));

  it('releases a proven waiter done even when the leader later fails elsewhere, filtering foreign diagnostics', () =>
    withDaemon(5, (fixture) =>
      Effect.gen(function* () {
        const staged = stagedCargo(fixture, [
          'sleep:0.4',
          artifactLine('aa'),
          'sleep:0.6',
          errorLine('bb', 'error[E0999]: bb broke'),
          '{"reason":"build-finished","success":false}',
          'exit:101',
        ]);
        const leaderFiber = yield* Effect.forkChild(
          execRequest(fixture, {
            cwd: fixture.ws1,
            argv: [staged.cargoPath, 'check', '-p', 'aa', '-p', 'bb'],
            extraEnv: staged.extraEnv,
            timeoutMs: 15_000,
          }),
        );
        yield* pollReport(fixture, (report) =>
          report.active.some((record) => record.status === 'running'),
        );

        const followerMessages = yield* execRequest(fixture, {
          cwd: fixture.ws1,
          argv: [staged.cargoPath, 'check', '-p', 'aa', '--lib'],
          extraEnv: staged.extraEnv,
          timeoutMs: 15_000,
        });
        const followerExit = findExit(followerMessages);
        expect(followerExit.status).toBe('done');
        expect(followerExit.exitCode).toBe(0);
        // bb's rendered error is out of the waiter's scope.
        expect(decodeOutput(followerMessages, 'stderr')).not.toContain('bb broke');

        const leaderMessages = yield* Fiber.join(leaderFiber);
        const leaderExit = findExit(leaderMessages);
        expect(leaderExit.status).toBe('failed');
        // The leader sees the rendered diagnostic for bb.
        expect(decodeOutput(leaderMessages, 'stderr')).toContain('bb broke');
      }),
    ));

  it('fails a waiter early with scoped diagnostics when its own package breaks', () =>
    withDaemon(5, (fixture) =>
      Effect.gen(function* () {
        const staged = stagedCargo(fixture, [
          'sleep:0.5',
          errorLine('aa', 'error[E0308]: aa mismatched types'),
          'sleep:1.0',
          '{"reason":"build-finished","success":false}',
          'exit:101',
        ]);
        const leaderFiber = yield* Effect.forkChild(
          execRequest(fixture, {
            cwd: fixture.ws1,
            argv: [staged.cargoPath, 'check', '-p', 'aa', '-p', 'bb'],
            extraEnv: staged.extraEnv,
            timeoutMs: 15_000,
          }),
        );
        yield* pollReport(fixture, (report) =>
          report.active.some((record) => record.status === 'running'),
        );

        const followerMessages = yield* execRequest(fixture, {
          cwd: fixture.ws1,
          argv: [staged.cargoPath, 'check', '-p', 'aa', '--lib'],
          extraEnv: staged.extraEnv,
          timeoutMs: 15_000,
        });
        const followerDoneAtMs = Date.now();
        const followerExit = findExit(followerMessages);
        expect(followerExit.status).toBe('failed');
        expect(followerExit.exitCode).toBe(101);
        expect(decodeOutput(followerMessages, 'stderr')).toContain('aa mismatched types');

        const leaderMessages = yield* Fiber.join(leaderFiber);
        const leaderDoneAtMs = Date.now();
        expect(findExit(leaderMessages).status).toBe('failed');
        // The waiter failed early, before the leader's trailing sleep ended.
        expect(leaderDoneAtMs - followerDoneAtMs).toBeGreaterThanOrEqual(300);
      }),
    ));

  it('scope-filters replay and durable tails for late coverage attachments', () =>
    withDaemon(5, (fixture) =>
      Effect.gen(function* () {
        const staged = stagedCargo(fixture, [
          'sleep:0.2',
          errorLine('bb', 'error[E0999]: replay must hide bb'),
          'sleep:1.0',
          artifactLine('aa'),
          '{"reason":"build-finished","success":false}',
          'exit:101',
        ]);
        const leaderFiber = yield* Effect.forkChild(
          execRequest(fixture, {
            cwd: fixture.ws1,
            argv: [staged.cargoPath, 'check', '-p', 'aa', '-p', 'bb'],
            extraEnv: staged.extraEnv,
            timeoutMs: 15_000,
          }),
        );
        yield* pollReport(fixture, (report) =>
          report.active.some((record) => record.status === 'running'),
        );
        yield* Effect.sleep('500 millis');

        const followerMessages = yield* execRequest(fixture, {
          cwd: fixture.ws1,
          argv: [staged.cargoPath, 'check', '-p', 'aa', '--lib'],
          extraEnv: staged.extraEnv,
          timeoutMs: 15_000,
        });
        const followerExit = findExit(followerMessages);
        expect(followerExit.status).toBe('done');
        expect(decodeOutput(followerMessages, 'stderr')).not.toContain('replay must hide bb');

        const report = yield* pollReport(fixture, (candidate) =>
          candidate.recent.some(
            (record) => record.ticket === followerExit.ticket && record.status === 'done',
          ),
        );
        const followerRecord = report.recent.find(
          (record) => record.ticket === followerExit.ticket,
        );
        expect(followerRecord?.outputTail).toBeNull();
        const db = openLedgerDatabase(fixture.config.databasePath);
        const durableFollower = yield* createLedgerApi(db).getRequestByTicket(
          followerExit.ticket,
        );
        db.close();
        expect(durableFollower?.outputTail).not.toContain('replay must hide bb');

        const leaderMessages = yield* Fiber.join(leaderFiber);
        expect(findExit(leaderMessages).status).toBe('failed');
        expect(decodeOutput(leaderMessages, 'stderr')).toContain('replay must hide bb');
      }),
    ));

  it('stores ANSI verbatim; the consumer seam strips only for no-color environments', () =>
    withDaemon(5, (fixture) =>
      Effect.gen(function* () {
        const esc = '\u001b';
        const staged = stagedCargo(fixture, [
          errorLine(
            'aa',
            `${esc}[0m${esc}[1m${esc}[38;5;9merror[E0432]${esc}[0m${esc}[1m: unresolved import${esc}[0m\n ${esc}[1m${esc}[94m--> ${esc}[0msrc/lib.rs:3:5`,
          ),
          '{"reason":"build-finished","success":false}',
          'exit:101',
        ]);
        const messages = yield* execRequest(fixture, {
          cwd: fixture.ws1,
          argv: [staged.cargoPath, 'check', '-p', 'aa'],
          extraEnv: staged.extraEnv,
          timeoutMs: 15_000,
        });
        const exit = findExit(messages);
        expect(exit.status).toBe('failed');
        // The live stream carries the colored bytes; the exec client decides
        // at display time whether its consumer gets them.
        const liveStderr = decodeOutput(messages, 'stderr');
        expect(liveStderr).toContain(`${esc}[38;5;9merror[E0432]`);

        // Storage keeps color: the ledger row and status report are the
        // shared source for consumers with and without color support.
        const report = yield* pollReport(fixture, (candidate) =>
          candidate.recent.some((record) => record.ticket === exit.ticket),
        );
        const record = report.recent.find((item) => item.ticket === exit.ticket);
        expect(record?.errorCount).toBe(1);
        expect(record?.diagnostics?.join('')).toContain(`${esc}[38;5;9merror[E0432]`);

        const db = openLedgerDatabase(fixture.config.databasePath);
        const durable = yield* createLedgerApi(db).getRequestByTicket(exit.ticket);
        db.close();
        expect(durable?.outputTail).toContain(`${esc}[38;5;9merror[E0432]`);

        // The operations seam projects records per consumer: NO_COLOR gets
        // zero ESC (so JSON surfaces never show `\u001b[…`), FORCE_COLOR
        // keeps the CSI sequences even without a TTY.
        const previousEnv = {
          forceColor: process.env.FORCE_COLOR,
          noColor: process.env.NO_COLOR,
          stateDir: process.env.CARGO_CONDUCTOR_STATE_DIR,
        };
        const context = { signal: new AbortController().signal };
        try {
          process.env.CARGO_CONDUCTOR_STATE_DIR = fixture.config.stateDir;
          process.env.NO_COLOR = '1';
          delete process.env.FORCE_COLOR;
          const plain = yield* Effect.promise(() =>
            defaultTicketOperations.result({ ticket: exit.ticket }, context),
          );
          expect(plain.request?.diagnostics?.join('')).toContain('error[E0432]: unresolved import');
          expect(plain.request?.diagnostics?.join('')).not.toContain(esc);
          expect(plain.request?.outputTail ?? '').not.toContain(esc);
          expect(JSON.stringify(plain.request)).not.toContain('\\u001b');

          delete process.env.NO_COLOR;
          process.env.FORCE_COLOR = '1';
          const colored = yield* Effect.promise(() =>
            defaultTicketOperations.result({ ticket: exit.ticket }, context),
          );
          expect(colored.request?.diagnostics?.join('')).toContain(`${esc}[38;5;9merror[E0432]`);
        } finally {
          restoreEnv('CARGO_CONDUCTOR_STATE_DIR', previousEnv.stateDir);
          restoreEnv('NO_COLOR', previousEnv.noColor);
          restoreEnv('FORCE_COLOR', previousEnv.forceColor);
        }
      }),
    ));

  it('keeps caller-chosen message formats verbatim (no demux double-parse)', () =>
    withDaemon(5, (fixture) =>
      Effect.gen(function* () {
        const messages = yield* execRequest(fixture, {
          cwd: fixture.ws1,
          argv: ['cargo', 'check', '--message-format=json'],
          timeoutMs: 12_000,
        });
        const exit = findExit(messages);
        expect(exit.status).toBe('done');
        // The fake cargo echoes its argv: exactly one message-format flag,
        // the caller's own.
        const stdout = decodeOutput(messages, 'stdout');
        expect(stdout).toContain('check --message-format=json');
        expect(stdout).not.toContain('json-diagnostic-rendered-ansi');
      }),
    ));
});
