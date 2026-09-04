import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'effect-rstest';
import * as Effect from 'effect/Effect';
import * as Fiber from 'effect/Fiber';

import type { ServerMessage } from '../src/daemon/protocol.js';
import { realCargoBin } from '../src/daemon/real-cargo.js';

import { decodeOutput, execRequest, findExit, pollReport, scopedDaemon } from './harness.js';
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
  it.live(
    'migrates followers already attached to a folded queued job',
    () =>
      Effect.gen(function* () {
        const fixture = yield* scopedDaemon(1);
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

        // Same filter, different package: the only shape that folds (#53).
        const beta = yield* Effect.forkChild(
          execRequest(fixture, {
            argv: ['cargo', 'test', '-p', 'bb', '--', 'filter_a'],
            cwd: fixture.ws1,
            timeoutMs: 30_000,
          }),
        );
        yield* pollReport(fixture, (report) =>
          report.active.some(
            (record) => record.status === 'queued' && record.argv.includes('bb'),
          ),
        );
        const betaFollower = yield* Effect.forkChild(
          execRequest(fixture, {
            argv: ['cargo', 'test', '-p', 'bb', '--', 'filter_a'],
            cwd: fixture.ws1,
            timeoutMs: 30_000,
          }),
        );
        const queued = yield* pollReport(fixture, (report) =>
          report.active.some(
            (record) => record.argv.includes('bb') && record.attachedTo !== null,
          ),
        );
        const queuedFollower = queued.active.find(
          (record) => record.argv.includes('bb') && record.attachedTo !== null,
        );
        expect(queuedFollower?.status).toBe('queued');
        expect(queuedFollower?.startedAtMs).toBeNull();

        const betaFollowerMessages = yield* Fiber.join(betaFollower);
        const betaFollowerExit = findExit(betaFollowerMessages);
        expect(betaFollowerExit.status).toBe('done');
        expect(betaFollowerExit.exitCode).toBe(0);
        const output = decodeOutput(betaFollowerMessages, 'stdout');
        expect(output).toContain('-p aa');
        expect(output).toContain('-p bb');
        expect(output).toContain('filter_a');

        yield* Effect.forEach(
          [alpha, alphaFollowerOne, alphaFollowerTwo, beta],
          Fiber.join,
          { concurrency: 'unbounded', discard: true },
        );
      }),
    45_000,
  );

  it.live(
    'runs distinct filters on the same package separately instead of folding them',
    () =>
      Effect.gen(function* () {
        // Before #53 these two folded into `cargo test -p ccfold -- alpha_only
        // beta_only`, so each ticket ran (and could fail on) the other's
        // test. Folding now requires an identical selection; different
        // filters each get their own real cargo run.
        const fixture = yield* scopedDaemon(1);
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
              extraEnv: { CARGO_HAULER_CARGO_BIN: realCargo },
              timeoutMs: 180_000,
            }),
            execRequest(fixture, {
              argv: ['cargo', 'test', '-p', 'ccfold', '--', 'beta_only'],
              cwd: workspace,
              extraEnv: { CARGO_HAULER_CARGO_BIN: realCargo },
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
        // Each participant sees only its own selection.
        const alphaStdout = decodeOutput(alpha, 'stdout');
        expect(alphaStdout).toContain('test alpha_only ... ok');
        expect(alphaStdout).not.toContain('beta_only');
        const betaStdout = decodeOutput(beta, 'stdout');
        expect(betaStdout).toContain('test beta_only ... ok');
        expect(betaStdout).not.toContain('alpha_only');

        const report = yield* pollReport(fixture, (candidate) =>
          [alphaExit.ticket, betaExit.ticket].every((ticket) =>
            candidate.recent.some(
              (record) => record.ticket === ticket && record.status === 'done',
            ),
          ),
        );
        for (const ticket of [alphaExit.ticket, betaExit.ticket]) {
          const record = report.recent.find((candidate) => candidate.ticket === ticket);
          expect(record?.attachedTo).toBeNull();
          expect(record?.execArgv).not.toBeNull();
          expect(record?.execArgv).not.toContain('--no-fail-fast');
        }
      }),
    240_000,
  );

  it.live(
    'requeues a folded follower when the composite fails and it did not name every package',
    () =>
      Effect.gen(function* () {
        // The issue's scenario (#53): agent A's `-p aa` tests fail, agent
        // B's `-p bb` tests are green. B rode A's composite, so B must not
        // inherit A's failure; it runs alone and reports its own result.
        const fixture = yield* scopedDaemon(1);
        yield* execRequest(fixture, {
          cwd: fixture.ws1,
          isTerminal: startedThenDetach,
          sleep: '1',
        });
        // Submit alpha first so it becomes the leader (ties go to the older
        // ticket) and the composite runs with alpha's failing exit.
        const alpha = yield* Effect.forkChild(
          execRequest(fixture, {
            argv: ['cargo', 'test', '-p', 'aa', '--', 'filter_a'],
            cwd: fixture.ws1,
            exit: '5',
            timeoutMs: 15_000,
          }),
        );
        yield* pollReport(fixture, (report) =>
          report.active.some(
            (record) => record.status === 'queued' && record.argv.includes('aa'),
          ),
        );
        const beta = yield* Effect.forkChild(
          execRequest(fixture, {
            argv: ['cargo', 'test', '-p', 'bb', '--', 'filter_a'],
            cwd: fixture.ws1,
            timeoutMs: 15_000,
          }),
        );
        const alphaMessages = yield* Fiber.join(alpha);
        const betaMessages = yield* Fiber.join(beta);

        // The composite carried both packages and the injected
        // --no-fail-fast, and its failure is the leader's own.
        const alphaStdout = decodeOutput(alphaMessages, 'stdout');
        expect(alphaStdout).toContain('-p aa');
        expect(alphaStdout).toContain('-p bb');
        expect(alphaStdout).toContain('--no-fail-fast');
        const alphaExit = findExit(alphaMessages);
        expect(alphaExit.status).toBe('failed');
        expect(alphaExit.exitCode).toBe(5);
        expect(alphaMessages.some((message) => message.type === 'requeued')).toBe(false);

        // The follower saw the composite, was requeued, ran `-p bb` alone,
        // and finished with its own (passing) result.
        expect(betaMessages.some((message) => message.type === 'requeued')).toBe(true);
        const betaExit = findExit(betaMessages);
        expect(betaExit.status).toBe('done');
        expect(betaExit.exitCode).toBe(0);
        const betaStdout = decodeOutput(betaMessages, 'stdout');
        expect(betaStdout).toContain('fake-out:test -p bb -- filter_a');

        const report = yield* pollReport(fixture, (candidate) =>
          [alphaExit.ticket, betaExit.ticket].every((ticket) =>
            candidate.recent.some((record) => record.ticket === ticket),
          ),
        );
        const betaRecord = report.recent.find((record) => record.ticket === betaExit.ticket);
        expect(betaRecord?.status).toBe('done');
        expect(betaRecord?.attachedTo).toBeNull();
        expect(betaRecord?.execArgv).toEqual(['cargo', 'test', '-p', 'bb', '--', 'filter_a']);
      }),
    30_000,
  );

  it.live(
    'mirrors the composite failure to a follower that named every composite package',
    () =>
      Effect.gen(function* () {
        // `-p aa -p bb` asked for exactly what the composite ran, so the
        // failure is genuinely its own: no requeue, one run.
        const fixture = yield* scopedDaemon(1);
        yield* execRequest(fixture, {
          cwd: fixture.ws1,
          isTerminal: startedThenDetach,
          sleep: '1',
        });
        const alpha = yield* Effect.forkChild(
          execRequest(fixture, {
            argv: ['cargo', 'test', '-p', 'aa', '--', 'filter_a'],
            cwd: fixture.ws1,
            exit: '5',
            timeoutMs: 15_000,
          }),
        );
        yield* pollReport(fixture, (report) =>
          report.active.some(
            (record) => record.status === 'queued' && record.argv.includes('aa'),
          ),
        );
        const wide = yield* Effect.forkChild(
          execRequest(fixture, {
            argv: ['cargo', 'test', '-p', 'aa', '-p', 'bb', '--', 'filter_a'],
            cwd: fixture.ws1,
            timeoutMs: 15_000,
          }),
        );
        const alphaMessages = yield* Fiber.join(alpha);
        const wideMessages = yield* Fiber.join(wide);

        expect(findExit(alphaMessages).status).toBe('failed');
        const wideExit = findExit(wideMessages);
        expect(wideExit.status).toBe('failed');
        expect(wideExit.exitCode).toBe(5);
        expect(wideMessages.some((message) => message.type === 'requeued')).toBe(false);
        expect(wideMessages.filter((message) => message.type === 'started').length).toBe(1);
        const stdout = decodeOutput(wideMessages, 'stdout');
        expect(stdout).toContain('-p aa');
        expect(stdout).toContain('-p bb');
        expect(stdout).toContain('--no-fail-fast');
      }),
    30_000,
  );

  it.live(
    'folds queued nextest runs that share a filterset across packages',
    () =>
      Effect.gen(function* () {
        const fixture = yield* scopedDaemon(1);
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
              argv: ['cargo', 'nextest', 'run', '-p', 'bb', '-E', 'test(alpha)'],
              cwd: fixture.ws1,
              timeoutMs: 15_000,
            }),
          ],
          { concurrency: 'unbounded' },
        );

        expect(findExit(alpha).status).toBe('done');
        expect(findExit(beta).status).toBe('done');
        // One composite ran: -p union, the shared filterset once, and
        // --no-fail-fast; nothing was re-expressed as package(...) terms.
        const stdout = decodeOutput(alpha, 'stdout');
        expect(stdout).toContain('-p aa');
        expect(stdout).toContain('-p bb');
        expect(stdout).toContain('-E test(alpha)');
        expect(stdout).not.toContain('package(');
        expect(stdout).toContain('--no-fail-fast');
      }),
    30_000,
  );

  it.live(
    'does not fold nextest runs whose filtersets differ',
    () =>
      Effect.gen(function* () {
        const fixture = yield* scopedDaemon(1);
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

        for (const messages of [alpha, beta]) {
          expect(findExit(messages).status).toBe('done');
        }
        const alphaStdout = decodeOutput(alpha, 'stdout');
        expect(alphaStdout).toContain('-p aa');
        expect(alphaStdout).not.toContain('-p bb');
        expect(alphaStdout).not.toContain('--no-fail-fast');
        const betaStdout = decodeOutput(beta, 'stdout');
        expect(betaStdout).toContain('-p bb');
        expect(betaStdout).not.toContain('-p aa');
      }),
    30_000,
  );
});
