import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from '@rstest/core';
import * as Effect from 'effect/Effect';
import * as Fiber from 'effect/Fiber';

import { decodeOutput, execRequest, findExit, pollReport, withDaemon } from './harness.js';
import type { Fixture } from './harness.js';

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
        const leaderFiber = yield* Effect.fork(
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
        const leaderFiber = yield* Effect.fork(
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
        const leaderFiber = yield* Effect.fork(
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
