import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from '@rstest/core';
import * as Effect from 'effect/Effect';
import * as Fiber from 'effect/Fiber';

import type { ServerMessage } from '../src/daemon/protocol.js';
import { realCargoBin } from '../src/daemon/real-cargo.js';

import { decodeOutput, execRequest, findExit, pollReport, withDaemon } from './harness.js';
import type { Fixture } from './harness.js';

/**
 * A real single-crate workspace with two named unit tests, so the two
 * submitted filters select distinct tests and the combined run proves both
 * ran. Lives beside (not inside) the harness fake-cargo workspaces.
 */
const makeRealTestWorkspace = (fixture: Fixture): string => {
  const dir = join(fixture.root, 'wsfold');
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(
    join(dir, 'Cargo.toml'),
    '[package]\nname = "ccfold"\nversion = "0.1.0"\nedition = "2021"\n',
  );
  writeFileSync(
    join(dir, 'src', 'lib.rs'),
    '#[test]\nfn alpha_only() {}\n\n#[test]\nfn beta_only() {}\n',
  );
  return dir;
};

const startedThenDetach = (message: ServerMessage): boolean => message.type === 'started';

describe('test batch folding', () => {
  it(
    'migrates followers already attached to a folded queued job',
    () =>
      withDaemon(1, (fixture) =>
        Effect.gen(function* () {
          yield* execRequest(fixture, {
            cwd: fixture.ws1,
            isTerminal: startedThenDetach,
            sleep: '2',
          });

          const alpha = yield* Effect.forkChild(
            execRequest(fixture, {
              argv: ['cargo', 'test', '-p', 'aa', '--', 'filter_a'],
              cwd: fixture.ws1,
              timeoutMs: 30_000,
            }),
          );
          yield* pollReport(fixture, (report) =>
            report.active.some(
              (record) => record.status === 'queued' && record.argv.includes('filter_a'),
            ),
          );
          const alphaFollowerOne = yield* Effect.forkChild(
            execRequest(fixture, {
              argv: ['cargo', 'test', '-p', 'aa', '--', 'filter_a'],
              cwd: fixture.ws1,
              timeoutMs: 30_000,
            }),
          );
          const alphaFollowerTwo = yield* Effect.forkChild(
            execRequest(fixture, {
              argv: ['cargo', 'test', '-p', 'aa', '--', 'filter_a'],
              cwd: fixture.ws1,
              timeoutMs: 30_000,
            }),
          );
          yield* pollReport(
            fixture,
            (report) =>
              report.active.filter(
                (record) => record.argv.includes('filter_a') && record.attachedTo !== null,
              ).length === 2,
          );

          const beta = yield* Effect.forkChild(
            execRequest(fixture, {
              argv: ['cargo', 'test', '-p', 'bb', '--', 'filter_b'],
              cwd: fixture.ws1,
              timeoutMs: 30_000,
            }),
          );
          yield* pollReport(fixture, (report) =>
            report.active.some(
              (record) => record.status === 'queued' && record.argv.includes('filter_b'),
            ),
          );
          const betaFollower = yield* Effect.forkChild(
            execRequest(fixture, {
              argv: ['cargo', 'test', '-p', 'bb', '--', 'filter_b'],
              cwd: fixture.ws1,
              timeoutMs: 30_000,
            }),
          );
          const queued = yield* pollReport(fixture, (report) =>
            report.active.some(
              (record) => record.argv.includes('filter_b') && record.attachedTo !== null,
            ),
          );
          const queuedFollower = queued.active.find(
            (record) => record.argv.includes('filter_b') && record.attachedTo !== null,
          );
          expect(queuedFollower?.status).toBe('queued');
          expect(queuedFollower?.startedAtMs).toBeNull();

          const betaFollowerMessages = yield* Fiber.join(betaFollower);
          const betaFollowerExit = findExit(betaFollowerMessages);
          expect(betaFollowerExit.status).toBe('done');
          expect(betaFollowerExit.exitCode).toBe(0);
          const output = decodeOutput(betaFollowerMessages, 'stdout');
          expect(output).toContain('filter_a');
          expect(output).toContain('filter_b');

          yield* Effect.forEach(
            [alpha, alphaFollowerOne, alphaFollowerTwo, beta],
            Fiber.join,
            { concurrency: 'unbounded', discard: true },
          );
        }),
      ),
    45_000,
  );

  it(
    'folds two queued cargo test filters into one --no-fail-fast run',
    () =>
      withDaemon(1, (fixture) =>
        Effect.gen(function* () {
          const workspace = makeRealTestWorkspace(fixture);
          const realCargo = realCargoBin({});
          // Blocker occupies the lane so both test requests queue behind it.
          yield* execRequest(fixture, {
            cwd: workspace,
            isTerminal: startedThenDetach,
            sleep: '2',
          });
          const [alpha, beta] = yield* Effect.all(
            [
              execRequest(fixture, {
                argv: ['cargo', 'test', '-p', 'ccfold', '--', 'alpha_only'],
                cwd: workspace,
                extraEnv: { CARGO_CONDUCTOR_CARGO_BIN: realCargo },
                timeoutMs: 180_000,
              }),
              execRequest(fixture, {
                argv: ['cargo', 'test', '-p', 'ccfold', '--', 'beta_only'],
                cwd: workspace,
                extraEnv: { CARGO_CONDUCTOR_CARGO_BIN: realCargo },
                timeoutMs: 180_000,
              }),
            ],
            { concurrency: 'unbounded' },
          );

          const alphaExit = findExit(alpha);
          const betaExit = findExit(beta);
          expect(alphaExit.status).toBe('done');
          expect(alphaExit.exitCode).toBe(0);
          expect(betaExit.status).toBe('done');
          expect(betaExit.exitCode).toBe(0);
          // Every participant sees the combined run: both selected tests ran.
          for (const messages of [alpha, beta]) {
            const stdout = decodeOutput(messages, 'stdout');
            expect(stdout).toContain('test alpha_only ... ok');
            expect(stdout).toContain('test beta_only ... ok');
          }

          const report = yield* pollReport(fixture, (candidate) =>
            [alphaExit.ticket, betaExit.ticket].every((ticket) =>
              candidate.recent.some(
                (record) => record.ticket === ticket && record.status === 'done',
              ),
            ),
          );
          const records = [alphaExit.ticket, betaExit.ticket].map((ticket) =>
            report.recent.find((record) => record.ticket === ticket),
          );
          const leader = records.find((record) => record?.attachedTo == null);
          const follower = records.find((record) => record?.attachedTo != null);
          // Exactly one spawned test run: the follower rode it as a batch
          // attachment and never received an exec argv of its own.
          expect(leader).toBeDefined();
          expect(follower?.attachMode).toBe('batch');
          expect(follower?.attachedTo).toBe(leader?.ticket);
          expect(follower?.savedComputeSource).toBe('estimate');
          expect(follower?.savedComputeMs).toBe(follower?.estimateMs);
          expect(follower?.execArgv).toBeNull();
          expect(leader?.execArgv).toContain('--no-fail-fast');
          expect(leader?.execArgv).toContain('--');
          expect(leader?.execArgv).toContain('alpha_only');
          expect(leader?.execArgv).toContain('beta_only');
        }),
      ),
    240_000,
  );

  it(
    'mirrors a folded test failure to the batch follower without requeueing',
    () =>
      withDaemon(1, (fixture) =>
        Effect.gen(function* () {
          yield* execRequest(fixture, {
            cwd: fixture.ws1,
            isTerminal: startedThenDetach,
            sleep: '1',
          });
          const [alpha, beta] = yield* Effect.all(
            [
              execRequest(fixture, {
                argv: ['cargo', 'test', '-p', 'aa', '--', 'filter_a'],
                cwd: fixture.ws1,
                exit: '5',
                timeoutMs: 15_000,
              }),
              execRequest(fixture, {
                argv: ['cargo', 'test', '-p', 'bb', '--', 'filter_b'],
                cwd: fixture.ws1,
                exit: '5',
                timeoutMs: 15_000,
              }),
            ],
            { concurrency: 'unbounded' },
          );

          // The fake cargo echoed the composite invocation: one run carried
          // both packages, both filters, and the injected --no-fail-fast.
          const stdout = decodeOutput(alpha, 'stdout');
          expect(stdout).toContain('--no-fail-fast');
          expect(stdout).toContain('filter_a');
          expect(stdout).toContain('filter_b');
          // Shared exit semantics: the composite's failure IS each
          // participant's failure — nobody requeues to run alone.
          for (const messages of [alpha, beta]) {
            const exit = findExit(messages);
            expect(exit.status).toBe('failed');
            expect(exit.exitCode).toBe(5);
            expect(messages.some((message) => message.type === 'requeued')).toBe(false);
            expect(
              messages.filter((message) => message.type === 'started').length,
            ).toBe(1);
          }
        }),
      ),
    30_000,
  );

  it(
    'folds queued nextest runs behind one composite -E filterset',
    () =>
      withDaemon(1, (fixture) =>
        Effect.gen(function* () {
          yield* execRequest(fixture, {
            cwd: fixture.ws1,
            isTerminal: startedThenDetach,
            sleep: '1',
          });
          const [alpha, beta] = yield* Effect.all(
            [
              execRequest(fixture, {
                argv: ['cargo', 'nextest', 'run', '-p', 'aa', '-E', 'test(alpha)'],
                cwd: fixture.ws1,
                timeoutMs: 15_000,
              }),
              execRequest(fixture, {
                argv: ['cargo', 'nextest', 'run', '-p', 'bb'],
                cwd: fixture.ws1,
                timeoutMs: 15_000,
              }),
            ],
            { concurrency: 'unbounded' },
          );

          expect(findExit(alpha).status).toBe('done');
          expect(findExit(beta).status).toBe('done');
          // One composite ran: -p union, or-joined filterset, --no-fail-fast.
          const stdout = decodeOutput(alpha, 'stdout');
          expect(stdout).toContain('-p aa');
          expect(stdout).toContain('-p bb');
          expect(stdout).toContain('test(alpha)');
          expect(stdout).toContain('package(bb)');
          expect(stdout).toContain('--no-fail-fast');
        }),
      ),
    30_000,
  );
});
