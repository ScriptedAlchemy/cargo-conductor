import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'effect-rstest';
import * as Effect from 'effect/Effect';
import * as Fiber from 'effect/Fiber';

import type {
  RequestRecord,
  RequeuedMessage,
  ServerMessage,
  StatusReport,
} from '../src/daemon/protocol.js';
import { cargoJsonDemuxFlag } from '../src/lib/argv.js';

import { decodeOutput, execRequest, findExit, pollReport, scopedDaemon } from './harness.js';
import type { Fixture } from './harness.js';

/**
 * A staged fake cargo: executes FAKE_STAGE_FILE line by line — `sleep:N`,
 * `exit:N`, anything else is echoed to stdout verbatim — so a demuxed
 * composite can emit a realistic `--message-format=json` stream.
 */
const stagedCargoScript = `#!/usr/bin/env bash
while IFS= read -r line; do
  case "$line" in
    sleep:*) sleep "\${line#sleep:}" ;;
    exit:*) exit "\${line#exit:}" ;;
    *) printf '%s\\n' "$line" ;;
  esac
done < "$FAKE_STAGE_FILE"
exit 0
`;

const artifactLine = (name: string): string =>
  JSON.stringify({
    reason: 'compiler-artifact',
    package_id: `path+file:///fx#${name}@0.1.0`,
    target: { kind: ['lib'], name },
    fresh: false,
  });

const errorLine = (name: string, rendered: string): string =>
  JSON.stringify({
    reason: 'compiler-message',
    package_id: `path+file:///fx#${name}@0.1.0`,
    target: { kind: ['lib'], name },
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

const queuedCount = (report: StatusReport): number =>
  report.active.filter((record) => record.status === 'queued').length;

const recordFor = (report: StatusReport, ticket: string): RequestRecord | undefined =>
  [...report.active, ...report.recent].find((record) => record.ticket === ticket);

const settled =
  (tickets: readonly string[]) =>
  (report: StatusReport): boolean =>
    tickets.every((ticket) =>
      report.recent.some((record) => record.ticket === ticket && record.status !== 'running'),
    );

const findRequeued = (messages: readonly ServerMessage[]): RequeuedMessage | undefined =>
  messages.find((message): message is RequeuedMessage => message.type === 'requeued');

interface Submission {
  readonly argv: readonly string[];
  readonly extraEnv?: Readonly<Record<string, string>>;
}

/**
 * Occupies the lane with a slow default check, then queues `submissions`
 * one at a time (each observed queued before the next goes in, so the
 * scheduler's tie-break — the older id — makes the first one the leader).
 * They fold, or not, when the head settles and the lane takes the first.
 */
const queueBehindHead = (fixture: Fixture, submissions: readonly Submission[]) =>
  Effect.gen(function* () {
    const head = yield* Effect.forkChild(
      execRequest(fixture, { cwd: fixture.ws1, sleep: '2.5', timeoutMs: 20_000 }),
    );
    yield* pollReport(fixture, (report) =>
      report.active.some((record) => record.status === 'running'),
    );
    const fibers: Fiber.Fiber<readonly ServerMessage[], unknown>[] = [];
    for (const [index, submission] of submissions.entries()) {
      fibers.push(
        yield* Effect.forkChild(
          execRequest(fixture, {
            cwd: fixture.ws1,
            argv: submission.argv,
            ...(submission.extraEnv === undefined ? {} : { extraEnv: submission.extraEnv }),
            timeoutMs: 20_000,
          }),
        ),
      );
      yield* pollReport(fixture, (report) => queuedCount(report) === index + 1);
    }
    const messages = yield* Effect.forEach(fibers, Fiber.join);
    yield* Fiber.join(head);
    const exits = messages.map(findExit);
    const report = yield* pollReport(
      fixture,
      settled(exits.map((exit) => exit.ticket)),
    );
    return { messages, exits, report };
  });

const warningsTrailer = ['--', '-D', 'warnings'];

describe('compile batches with a `--` trailer (#86)', () => {
  it.live('folds two clippys with the same `-- -D warnings` trailer into one composite that carries it once', () =>
    Effect.gen(function* () {
      const fixture = yield* scopedDaemon(1);
      const { messages, exits, report } = yield* queueBehindHead(fixture, [
        { argv: ['cargo', 'clippy', '-p', 'alpha', ...warningsTrailer] },
        { argv: ['cargo', 'clippy', '-p', 'beta', ...warningsTrailer] },
      ]);
      const [alphaExit, betaExit] = exits;
      expect(alphaExit?.status).toBe('done');
      expect(betaExit?.status).toBe('done');
      const alpha = recordFor(report, alphaExit?.ticket ?? '');
      const beta = recordFor(report, betaExit?.ticket ?? '');
      expect(beta?.attachedTo).toBe(alphaExit?.ticket);
      expect(beta?.attachMode).toBe('batch');
      // The demux flag stays a cargo option, the followers' `-p` join the
      // leader's, and the trailer appears exactly once, at the end.
      expect(alpha?.execArgv).toEqual([
        'cargo',
        'clippy',
        '-p',
        'alpha',
        '-p',
        'beta',
        cargoJsonDemuxFlag,
        '--',
        '-D',
        'warnings',
      ]);
      // The fake cargo echoes the argv it actually received.
      expect(decodeOutput(messages[0] ?? [], 'stdout')).toContain(
        `fake-out:clippy -p alpha -p beta ${cargoJsonDemuxFlag} -- -D warnings`,
      );
    }));

  it.live('proves a --lib follower whose units compiled cleanly when another participant fails under -D warnings', () =>
    Effect.gen(function* () {
      const fixture = yield* scopedDaemon(1);
      const staged = stagedCargo(fixture, [
        'sleep:0.3',
        artifactLine('aa'),
        'sleep:0.3',
        errorLine('bb', 'error: unused variable: `x` (-D warnings)'),
        '{"reason":"build-finished","success":false}',
        'exit:101',
      ]);
      const { messages, exits, report } = yield* queueBehindHead(fixture, [
        {
          argv: [staged.cargoPath, 'clippy', '-p', 'bb', '--lib', ...warningsTrailer],
          extraEnv: staged.extraEnv,
        },
        {
          argv: [staged.cargoPath, 'clippy', '-p', 'aa', '--lib', ...warningsTrailer],
          extraEnv: staged.extraEnv,
        },
      ]);
      const [bbExit, aaExit] = exits;
      // The leader keeps the composite's exit: bb's warning was denied.
      expect(bbExit?.status).toBe('failed');
      expect(bbExit?.exitCode).toBe(101);
      // aa's lib unit compiled cleanly before bb failed, so the demux proves
      // its demand despite the composite failure — the trailer did not
      // disable demultiplexing.
      expect(aaExit?.status).toBe('done');
      expect(aaExit?.exitCode).toBe(0);
      const aaStderr = decodeOutput(messages[1] ?? [], 'stderr');
      expect(aaStderr).toContain('compiled cleanly');
      expect(aaStderr).not.toContain('unused variable');
      expect(findRequeued(messages[1] ?? [])).toBeUndefined();
      const bb = recordFor(report, bbExit?.ticket ?? '');
      const aa = recordFor(report, aaExit?.ticket ?? '');
      expect(aa?.attachedTo).toBe(bbExit?.ticket);
      expect(aa?.attachMode).toBe('batch');
      expect(bb?.execArgv).toEqual([
        staged.cargoPath,
        'clippy',
        '-p',
        'bb',
        '--lib',
        '-p',
        'aa',
        cargoJsonDemuxFlag,
        '--',
        '-D',
        'warnings',
      ]);
    }));

  it.live('requeues a follower it cannot prove when the composite fails, rerunning it alone with its own trailer', () =>
    Effect.gen(function* () {
      const fixture = yield* scopedDaemon(1);
      // The composite runs with the leader's cargo and environment: bb fails.
      const leaderCargo = stagedCargo(fixture, [
        'sleep:0.3',
        artifactLine('aa'),
        errorLine('bb', 'error: unused variable: `x` (-D warnings)'),
        '{"reason":"build-finished","success":false}',
        'exit:101',
      ]);
      // The requeued follower runs with its own: aa alone succeeds.
      const followerCargo = stagedCargo(fixture, [
        artifactLine('aa'),
        '{"reason":"build-finished","success":true}',
        'exit:0',
      ]);
      const { messages, exits, report } = yield* queueBehindHead(fixture, [
        {
          argv: [leaderCargo.cargoPath, 'clippy', '-p', 'bb', ...warningsTrailer],
          extraEnv: leaderCargo.extraEnv,
        },
        {
          argv: [followerCargo.cargoPath, 'clippy', '-p', 'aa', ...warningsTrailer],
          extraEnv: followerCargo.extraEnv,
        },
      ]);
      const [bbExit, aaExit] = exits;
      expect(bbExit?.status).toBe('failed');
      // Without `--lib` the demand is not provable from the artifact stream,
      // and a compile-batch follower never inherits the composite's failure.
      const requeued = findRequeued(messages[1] ?? []);
      expect(requeued?.reason).toContain('batched run failed');
      expect(aaExit?.status).toBe('done');
      expect(aaExit?.exitCode).toBe(0);
      const bb = recordFor(report, bbExit?.ticket ?? '');
      const aa = recordFor(report, aaExit?.ticket ?? '');
      expect(bb?.execArgv).toEqual([
        leaderCargo.cargoPath,
        'clippy',
        '-p',
        'bb',
        '-p',
        'aa',
        cargoJsonDemuxFlag,
        '--',
        '-D',
        'warnings',
      ]);
      // The rerun is aa's own invocation, demuxed, trailer intact.
      expect(aa?.execArgv).toEqual([
        followerCargo.cargoPath,
        'clippy',
        '-p',
        'aa',
        cargoJsonDemuxFlag,
        '--',
        '-D',
        'warnings',
      ]);
    }));
});

describe('test folding across filters and harness flags (#87)', () => {
  it.live('folds different packages with different bare filters into one run over the union of both', () =>
    Effect.gen(function* () {
      const fixture = yield* scopedDaemon(1);
      const { messages, exits, report } = yield* queueBehindHead(fixture, [
        { argv: ['cargo', 'test', '-p', 'alpha', '--', 'f1'] },
        { argv: ['cargo', 'test', '-p', 'beta', '--', 'f2', 'f3'] },
      ]);
      const [alphaExit, betaExit] = exits;
      expect(alphaExit?.status).toBe('done');
      expect(betaExit?.status).toBe('done');
      const alpha = recordFor(report, alphaExit?.ticket ?? '');
      const beta = recordFor(report, betaExit?.ticket ?? '');
      expect(beta?.attachedTo).toBe(alphaExit?.ticket);
      expect(beta?.attachMode).toBe('batch');
      expect(alpha?.execArgv).toEqual([
        'cargo',
        'test',
        '-p',
        'alpha',
        '-p',
        'beta',
        '--no-fail-fast',
        '--',
        'f1',
        'f2',
        'f3',
      ]);
      // Both callers see the composite's output.
      const composite = 'fake-out:test -p alpha -p beta --no-fail-fast -- f1 f2 f3';
      expect(decodeOutput(messages[0] ?? [], 'stdout')).toContain(composite);
      expect(decodeOutput(messages[1] ?? [], 'stdout')).toContain(composite);
    }));

  it.live('folds --lib runs sharing --test-threads=4, keeping the leader trailer once with the new filters ahead of it', () =>
    Effect.gen(function* () {
      const fixture = yield* scopedDaemon(1);
      const { exits, report } = yield* queueBehindHead(fixture, [
        { argv: ['cargo', 'test', '-p', 'alpha', '--lib', '--', 'f1', '--test-threads=4'] },
        { argv: ['cargo', 'test', '-p', 'beta', '--lib', '--', 'f2', '--test-threads', '4'] },
      ]);
      const [alphaExit, betaExit] = exits;
      expect(alphaExit?.status).toBe('done');
      expect(betaExit?.status).toBe('done');
      const alpha = recordFor(report, alphaExit?.ticket ?? '');
      const beta = recordFor(report, betaExit?.ticket ?? '');
      expect(beta?.attachedTo).toBe(alphaExit?.ticket);
      expect(beta?.attachMode).toBe('batch');
      expect(alpha?.execArgv).toEqual([
        'cargo',
        'test',
        '-p',
        'alpha',
        '--lib',
        '-p',
        'beta',
        '--no-fail-fast',
        '--',
        'f1',
        'f2',
        '--test-threads=4',
      ]);
    }));

  it.live('does not fold runs whose --test-threads differ', () =>
    Effect.gen(function* () {
      const fixture = yield* scopedDaemon(1);
      const { exits, report } = yield* queueBehindHead(fixture, [
        { argv: ['cargo', 'test', '-p', 'alpha', '--', 'f1', '--test-threads=4'] },
        { argv: ['cargo', 'test', '-p', 'beta', '--', 'f2', '--test-threads=2'] },
      ]);
      const [alphaExit, betaExit] = exits;
      expect(alphaExit?.status).toBe('done');
      expect(betaExit?.status).toBe('done');
      const alpha = recordFor(report, alphaExit?.ticket ?? '');
      const beta = recordFor(report, betaExit?.ticket ?? '');
      expect(alpha?.attachedTo).toBeNull();
      expect(beta?.attachedTo).toBeNull();
      expect(alpha?.execArgv).toEqual(['cargo', 'test', '-p', 'alpha', '--', 'f1', '--test-threads=4']);
      expect(beta?.execArgv).toEqual(['cargo', 'test', '-p', 'beta', '--', 'f2', '--test-threads=2']);
    }));

});

describe('test folding with --exact (#97)', () => {
  it.live('folds two --exact runs on different packages into one run over both filters, carrying --exact once', () =>
    Effect.gen(function* () {
      const fixture = yield* scopedDaemon(1);
      const { messages, exits, report } = yield* queueBehindHead(fixture, [
        { argv: ['cargo', 'test', '-p', 'alpha', '--test', 'suite', '--', 'x::y', '--exact'] },
        { argv: ['cargo', 'test', '-p', 'beta', '--test', 'suite', '--', 'z::w', '--exact'] },
      ]);
      const [alphaExit, betaExit] = exits;
      expect(alphaExit?.status).toBe('done');
      expect(betaExit?.status).toBe('done');
      const alpha = recordFor(report, alphaExit?.ticket ?? '');
      const beta = recordFor(report, betaExit?.ticket ?? '');
      expect(beta?.attachedTo).toBe(alphaExit?.ticket);
      expect(beta?.attachMode).toBe('batch');
      // libtest OR-s the filters and applies `--exact` to each: the union
      // of packages with the union of filters, the flag once, last.
      expect(alpha?.execArgv).toEqual([
        'cargo',
        'test',
        '-p',
        'alpha',
        '--test',
        'suite',
        '-p',
        'beta',
        '--no-fail-fast',
        '--',
        'x::y',
        'z::w',
        '--exact',
      ]);
      expect(alpha?.execArgv?.filter((argument) => argument === '--exact')).toHaveLength(1);
      // One cargo ran, and both tickets settled from it: each caller sees
      // the argv the fake cargo received, and beta never ran its own.
      const composite =
        'fake-out:test -p alpha --test suite -p beta --no-fail-fast -- x::y z::w --exact';
      expect(decodeOutput(messages[0] ?? [], 'stdout')).toContain(composite);
      expect(decodeOutput(messages[1] ?? [], 'stdout')).toContain(composite);
      expect(decodeOutput(messages[1] ?? [], 'stdout')).not.toContain('fake-out:test -p beta');
      expect(findRequeued(messages[1] ?? [])).toBeUndefined();
    }));

  it.live('does not fold an --exact run with a substring run on the same filter: two separate cargo runs', () =>
    Effect.gen(function* () {
      const fixture = yield* scopedDaemon(1);
      const { messages, exits, report } = yield* queueBehindHead(fixture, [
        { argv: ['cargo', 'test', '-p', 'alpha', '--', 'x::y', '--exact'] },
        { argv: ['cargo', 'test', '-p', 'beta', '--', 'x::y'] },
      ]);
      const [alphaExit, betaExit] = exits;
      expect(alphaExit?.status).toBe('done');
      expect(betaExit?.status).toBe('done');
      const alpha = recordFor(report, alphaExit?.ticket ?? '');
      const beta = recordFor(report, betaExit?.ticket ?? '');
      expect(alpha?.attachedTo).toBeNull();
      expect(beta?.attachedTo).toBeNull();
      expect(alpha?.execArgv).toEqual(['cargo', 'test', '-p', 'alpha', '--', 'x::y', '--exact']);
      expect(beta?.execArgv).toEqual(['cargo', 'test', '-p', 'beta', '--', 'x::y']);
      // Each ran its own cargo: the substring run never saw `--exact`.
      expect(decodeOutput(messages[0] ?? [], 'stdout')).toContain(
        'fake-out:test -p alpha -- x::y --exact',
      );
      const betaStdout = decodeOutput(messages[1] ?? [], 'stdout');
      expect(betaStdout).toContain('fake-out:test -p beta -- x::y');
      expect(betaStdout).not.toContain('--exact');
    }));

  it.live('requeues an --exact participant that did not name every package when the composite fails, while one that did inherits it', () =>
    Effect.gen(function* () {
      const fixture = yield* scopedDaemon(1);
      const { messages, exits, report } = yield* queueBehindHead(fixture, [
        // The composite runs with the leader's environment: it fails.
        {
          argv: ['cargo', 'test', '-p', 'alpha', '--', 'x::y', '--exact'],
          extraEnv: { FAKE_EXIT: '101' },
        },
        { argv: ['cargo', 'test', '-p', 'beta', '--', 'z::w', '--exact'] },
        { argv: ['cargo', 'test', '-p', 'alpha', '-p', 'beta', '--', 'x::y', 'z::w', '--exact'] },
      ]);
      const [alphaExit, betaExit, wideExit] = exits;
      // The leader keeps the composite's exit.
      expect(alphaExit?.status).toBe('failed');
      expect(alphaExit?.exitCode).toBe(101);
      const alpha = recordFor(report, alphaExit?.ticket ?? '');
      expect(alpha?.execArgv).toEqual([
        'cargo',
        'test',
        '-p',
        'alpha',
        '-p',
        'beta',
        '--no-fail-fast',
        '--',
        'x::y',
        'z::w',
        '--exact',
      ]);
      // beta asked for neither alpha nor x::y, so the failing test may be
      // alpha's: it reruns alone, with its own argv and environment.
      expect(findRequeued(messages[1] ?? [])?.reason).toContain('batched run failed');
      expect(betaExit?.status).toBe('done');
      expect(betaExit?.exitCode).toBe(0);
      const beta = recordFor(report, betaExit?.ticket ?? '');
      expect(beta?.execArgv).toEqual(['cargo', 'test', '-p', 'beta', '--', 'z::w', '--exact']);
      expect(decodeOutput(messages[1] ?? [], 'stdout')).toContain(
        'fake-out:test -p beta -- z::w --exact',
      );
      // The wide participant asked for every package and every filter the
      // composite ran: the failure is its own.
      expect(findRequeued(messages[2] ?? [])).toBeUndefined();
      expect(wideExit?.status).toBe('failed');
      expect(wideExit?.exitCode).toBe(101);
      const wide = recordFor(report, wideExit?.ticket ?? '');
      expect(wide?.attachedTo).toBe(alphaExit?.ticket);
      expect(wide?.attachMode).toBe('batch');
    }));
});
