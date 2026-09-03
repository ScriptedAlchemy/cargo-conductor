import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'effect-rstest';
import * as Deferred from 'effect/Deferred';
import * as Effect from 'effect/Effect';
import * as Fiber from 'effect/Fiber';

import { Broker } from '../src/daemon/broker.js';
import type { BrokerApi, SubmitResult } from '../src/daemon/broker.js';
import type { ExitInfo, SubmitCallbacks, SubmitInput } from '../src/daemon/job-state.js';

import { brokerFixture } from './broker-fixture.js';
import type { Fixture } from './harness.js';

const cargoEnv = (
  fixture: Fixture,
  extra: Readonly<Record<string, string>> = {},
): Record<string, string> => ({
  CARGO_HAULER_CARGO_BIN: join(fixture.binDir, 'cargo'),
  ...extra,
});

interface Tracked {
  readonly submitted: SubmitResult;
  readonly started: Deferred.Deferred<void>;
  readonly exit: Deferred.Deferred<ExitInfo>;
  readonly stdout: () => string;
}

/** Submit with callbacks that expose the lifecycle as awaitable signals. */
const submitTracked = (
  broker: BrokerApi,
  input: SubmitInput,
  overrides: Partial<SubmitCallbacks> = {},
): Effect.Effect<Tracked, unknown> =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const exit = yield* Deferred.make<ExitInfo>();
    const chunks: string[] = [];
    const submitted = yield* broker.submit(input, {
      onExit: (info) => Effect.asVoid(Deferred.succeed(exit, info)),
      onOutput: (info) =>
        Effect.sync(() => {
          if (info.channel === 'stdout') {
            chunks.push(Buffer.from(info.data, 'base64').toString('utf8'));
          }
        }),
      onStarted: () => Effect.asVoid(Deferred.succeed(started, undefined)),
      ...overrides,
    });
    return { submitted, started, exit, stdout: () => chunks.join('') };
  });

/**
 * A staged fake cargo for JSON demux runs: executes FAKE_STAGE_FILE line by
 * line — `sleep:N`, `exit:N`, anything else is echoed to stdout verbatim.
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

const stagedCargo = (
  fixture: Fixture,
  stages: readonly string[],
): Record<string, string> => {
  const dir = join(fixture.root, 'staged');
  mkdirSync(dir, { recursive: true });
  const cargoPath = join(dir, 'cargo');
  writeFileSync(cargoPath, stagedCargoScript);
  chmodSync(cargoPath, 0o755);
  const stageFile = join(dir, 'stages.txt');
  writeFileSync(stageFile, `${stages.join('\n')}\n`);
  return { CARGO_HAULER_CARGO_BIN: cargoPath, FAKE_STAGE_FILE: stageFile };
};

describe('kill while parked (#51)', () => {
  it.live('settles a kill for a job parked on the admission permit without waiting for the holder', () =>
    Effect.gen(function* () {
      const { fixture, layer } = yield* brokerFixture(1);
      yield* Effect.scoped(
        Effect.gen(function* () {
          const broker = yield* Broker;
          const holder = yield* submitTracked(broker, {
            argv: ['cargo', 'check', '-p', 'holder'],
            cwd: fixture.ws1,
            env: cargoEnv(fixture, { FAKE_SLEEP: '10' }),
          });
          yield* Deferred.await(holder.started);

          // Another lane: its worker takes the job and parks on the permit.
          const parked = yield* submitTracked(
            broker,
            {
              argv: ['cargo', 'check', '-p', 'parked'],
              cwd: fixture.ws2,
              env: cargoEnv(fixture),
            },
            { onStarted: () => Effect.die(new Error('parked job must never start')) },
          );
          yield* Effect.sleep('150 millis');

          const killedAtMs = Date.now();
          expect(yield* broker.kill(parked.submitted.ticket)).toBe(true);
          const awaited = yield* broker.awaitTicket(parked.submitted.ticket, 3_000);
          expect(awaited.timedOut).toBe(false);
          expect(awaited.record?.status).toBe('killed');
          expect(awaited.record?.startedAtMs).toBeNull();
          expect(awaited.record?.error).toBe('killed while queued');
          const exit = yield* Deferred.await(parked.exit).pipe(Effect.timeout('1 second'));
          expect(exit.status).toBe('killed');
          expect(Date.now() - killedAtMs).toBeLessThan(3_000);

          yield* broker.kill(holder.submitted.ticket);
          yield* Deferred.await(holder.exit).pipe(Effect.timeout('10 seconds'));
        }),
      ).pipe(Effect.provide(layer));
    }));

  it.live('does not fold a kill-requested pending job into a batch', () =>
    Effect.gen(function* () {
      const { fixture, layer } = yield* brokerFixture(1);
      yield* Effect.scoped(
        Effect.gen(function* () {
          const broker = yield* Broker;
          const holder = yield* submitTracked(broker, {
            argv: ['cargo', 'check', '-p', 'holder'],
            cwd: fixture.ws1,
            env: cargoEnv(fixture, { FAKE_SLEEP: '10' }),
          });
          yield* Deferred.await(holder.started);

          const doomed = yield* submitTracked(
            broker,
            {
              argv: ['cargo', 'check', '-p', 'doomed'],
              cwd: fixture.ws1,
              env: cargoEnv(fixture),
            },
            { onStarted: () => Effect.die(new Error('killed job must never start')) },
          );
          const survivor = yield* submitTracked(broker, {
            argv: ['cargo', 'check', '-p', 'survivor'],
            cwd: fixture.ws1,
            env: cargoEnv(fixture),
          });
          // A rider on the survivor makes it the preferred batch leader, so
          // the doomed job is the fold candidate rather than the leader.
          const rider = yield* submitTracked(broker, {
            argv: ['cargo', 'check', '-p', 'survivor'],
            cwd: fixture.ws1,
            env: cargoEnv(fixture),
          });
          expect(rider.submitted.attachedTo).toBe(survivor.submitted.ticket);

          // Disconnect-style cleanup leaves the job in the lane's pending list.
          expect(yield* broker.kill(doomed.submitted.ticket, { onlyIfQueued: true })).toBe(true);
          yield* broker.kill(holder.submitted.ticket);

          const doomedResult = yield* broker.awaitTicket(doomed.submitted.ticket, 8_000);
          expect(doomedResult.timedOut).toBe(false);
          expect(doomedResult.record?.status).toBe('killed');
          expect(doomedResult.record?.error).toBe('killed while queued');
          expect(doomedResult.record?.attachedTo).toBeNull();

          const survivorResult = yield* broker.awaitTicket(survivor.submitted.ticket, 8_000);
          expect(survivorResult.record?.status).toBe('done');
          expect(survivorResult.record?.execArgv).not.toContain('doomed');
          const riderResult = yield* broker.awaitTicket(rider.submitted.ticket, 8_000);
          expect(riderResult.record?.status).toBe('done');
        }),
      ).pipe(Effect.provide(layer));
    }));

  it.live('completes settlement even when the ledger finish write fails', () =>
    Effect.gen(function* () {
      let failFinishForId: number | null = null;
      const { fixture, layer } = yield* brokerFixture(1, (base) => ({
        ...base,
        markFinished: (id, input) =>
          Effect.suspend(() => {
            if (id === failFinishForId) {
              failFinishForId = null;
              return Effect.die(new Error('SQLITE_BUSY: database is locked'));
            }
            return base.markFinished(id, input);
          }),
      }));
      yield* Effect.scoped(
        Effect.gen(function* () {
          const broker = yield* Broker;
          const leader = yield* submitTracked(broker, {
            argv: ['cargo', 'check', '-p', 'flaky-ledger'],
            cwd: fixture.ws1,
            env: cargoEnv(fixture, { FAKE_SLEEP: '0.3' }),
          });
          failFinishForId = Number(leader.submitted.ticket.slice('cc-'.length));

          // The exit callback still fires although the ledger write died.
          const exit = yield* Deferred.await(leader.exit).pipe(Effect.timeout('5 seconds'));
          expect(exit.status).toBe('done');

          // The stale leader left the directory: an identical request runs on
          // its own instead of attaching to a leader that will never exit.
          const successor = yield* submitTracked(broker, {
            argv: ['cargo', 'check', '-p', 'flaky-ledger'],
            cwd: fixture.ws1,
            env: cargoEnv(fixture),
          });
          expect(successor.submitted.attachedTo).toBeUndefined();
          const settled = yield* broker.awaitTicket(successor.submitted.ticket, 5_000);
          expect(settled.timedOut).toBe(false);
          expect(settled.record?.status).toBe('done');
        }),
      ).pipe(Effect.provide(layer));
    }));
});

describe('attachment registration races (#52)', () => {
  it.live('replays each leader chunk exactly once to a late attacher', () =>
    Effect.gen(function* () {
      let leaderTicket: string | null = null;
      const { fixture, layer } = yield* brokerFixture(1, (base) => ({
        ...base,
        markAttached: (id, input) =>
          // Widen the window between registration and the replay snapshot
          // while the leader keeps emitting ticks.
          (input.leaderTicket === leaderTicket ? Effect.sleep('400 millis') : Effect.void).pipe(
            Effect.andThen(base.markAttached(id, input)),
          ),
      }));
      yield* Effect.scoped(
        Effect.gen(function* () {
          const broker = yield* Broker;
          const leader = yield* submitTracked(broker, {
            argv: ['cargo', 'check', '-p', 'ticker'],
            cwd: fixture.ws1,
            env: cargoEnv(fixture, {
              FAKE_OUTPUT_COUNT: '40',
              FAKE_OUTPUT_INTERVAL: '0.02',
              FAKE_SLEEP: '0.3',
            }),
          });
          leaderTicket = leader.submitted.ticket;
          yield* Deferred.await(leader.started);
          yield* Effect.sleep('120 millis');

          const follower = yield* submitTracked(broker, {
            argv: ['cargo', 'check', '-p', 'ticker'],
            cwd: fixture.ws1,
            env: cargoEnv(fixture),
          });
          expect(follower.submitted.attachedTo).toBe(leader.submitted.ticket);
          const exit = yield* Deferred.await(follower.exit).pipe(Effect.timeout('10 seconds'));
          expect(exit.status).toBe('done');

          const ticks = follower
            .stdout()
            .split('\n')
            .filter((line) => line.startsWith('fake-tick:'));
          expect(ticks.length).toBe(40);
          expect(new Set(ticks).size).toBe(ticks.length);
          yield* Deferred.await(leader.exit).pipe(Effect.timeout('10 seconds'));
        }),
      ).pipe(Effect.provide(layer));
    }));

  it.live('leaves a follower settled when its leader exits during registration', () =>
    Effect.gen(function* () {
      let leaderTicket: string | null = null;
      const followerExited = Deferred.makeUnsafe<ExitInfo>();
      const { fixture, layer } = yield* brokerFixture(1, (base) => ({
        ...base,
        // Hold the follower's attach write until the leader has settled and
        // mirrored its exit to the follower.
        markAttached: (id, input) =>
          (input.leaderTicket === leaderTicket
            ? Effect.asVoid(Deferred.await(followerExited))
            : Effect.void
          ).pipe(Effect.andThen(base.markAttached(id, input))),
      }));
      yield* Effect.scoped(
        Effect.gen(function* () {
          const broker = yield* Broker;
          const leader = yield* submitTracked(broker, {
            argv: ['cargo', 'check', '-p', 'racer'],
            cwd: fixture.ws1,
            env: cargoEnv(fixture, { FAKE_SLEEP: '0.4' }),
          });
          leaderTicket = leader.submitted.ticket;
          yield* Deferred.await(leader.started);

          const followerFiber = yield* Effect.forkChild(
            submitTracked(
              broker,
              {
                argv: ['cargo', 'check', '-p', 'racer'],
                cwd: fixture.ws1,
                env: cargoEnv(fixture),
              },
              { onExit: (info) => Effect.asVoid(Deferred.succeed(followerExited, info)) },
            ),
          );
          const leaderExit = yield* Deferred.await(leader.exit).pipe(Effect.timeout('10 seconds'));
          expect(leaderExit.status).toBe('done');
          const followerExit = yield* Deferred.await(followerExited).pipe(
            Effect.timeout('5 seconds'),
          );
          expect(followerExit.status).toBe('done');

          const follower = yield* Fiber.join(followerFiber);
          expect(follower.submitted.attachedTo).toBe(leader.submitted.ticket);
          // Settled rows stay settled: the late ledger writes must not
          // resurrect the follower as queued/running.
          yield* Effect.sleep('100 millis');
          const awaited = yield* broker.awaitTicket(follower.submitted.ticket, 2_000);
          expect(awaited.timedOut).toBe(false);
          expect(awaited.record?.status).toBe('done');
        }),
      ).pipe(Effect.provide(layer));
    }));

  it.live('keeps the leader running when an early follower release hits a ledger defect', () =>
    Effect.gen(function* () {
      let failFinishForId: number | null = null;
      const { fixture, layer } = yield* brokerFixture(1, (base) => ({
        ...base,
        markFinished: (id, input) =>
          Effect.suspend(() => {
            if (id === failFinishForId) {
              failFinishForId = null;
              return Effect.die(new Error('SQLITE_BUSY: database is locked'));
            }
            return base.markFinished(id, input);
          }),
      }));
      const env = stagedCargo(fixture, [
        'sleep:0.4',
        artifactLine('aa'),
        'sleep:0.6',
        artifactLine('bb'),
        '{"reason":"build-finished","success":true}',
        'exit:0',
      ]);
      yield* Effect.scoped(
        Effect.gen(function* () {
          const broker = yield* Broker;
          const leader = yield* submitTracked(broker, {
            argv: ['cargo', 'check', '-p', 'aa', '-p', 'bb'],
            cwd: fixture.ws1,
            env,
          });
          yield* Deferred.await(leader.started);

          const follower = yield* submitTracked(broker, {
            argv: ['cargo', 'check', '-p', 'aa', '--lib'],
            cwd: fixture.ws1,
            env,
          });
          expect(follower.submitted.attachMode).toBe('coverage');
          failFinishForId = Number(follower.submitted.ticket.slice('cc-'.length));

          // The follower is released early from the stdout pump; its failing
          // ledger write must neither kill the leader's cargo nor withhold
          // the follower's own exit.
          const followerExit = yield* Deferred.await(follower.exit).pipe(
            Effect.timeout('10 seconds'),
          );
          expect(followerExit.status).toBe('done');
          const leaderExit = yield* Deferred.await(leader.exit).pipe(Effect.timeout('10 seconds'));
          expect(leaderExit.status).toBe('done');
          expect(leaderExit.error).toBeNull();
          expect(failFinishForId).toBeNull();
        }),
      ).pipe(Effect.provide(layer));
    }));

  it.live('requires equal mergeStderr for identity attach on raw-output runs', () =>
    Effect.gen(function* () {
      const { fixture, layer } = yield* brokerFixture(1);
      yield* Effect.scoped(
        Effect.gen(function* () {
          const broker = yield* Broker;
          const merged = yield* submitTracked(broker, {
            argv: ['cargo', 'test', '-p', 'merged'],
            cwd: fixture.ws1,
            env: cargoEnv(fixture, { FAKE_SLEEP: '10' }),
            mergeStderr: true,
          });
          yield* Deferred.await(merged.started);

          const separate = yield* submitTracked(
            broker,
            {
              argv: ['cargo', 'test', '-p', 'merged'],
              cwd: fixture.ws1,
              env: cargoEnv(fixture),
            },
            { onStarted: () => Effect.die(new Error('queued follower must not start')) },
          );
          expect(separate.submitted.attachedTo).toBeUndefined();

          const alsoMerged = yield* submitTracked(broker, {
            argv: ['cargo', 'test', '-p', 'merged'],
            cwd: fixture.ws1,
            env: cargoEnv(fixture),
            mergeStderr: true,
          });
          expect(alsoMerged.submitted.attachedTo).toBe(merged.submitted.ticket);
          expect(alsoMerged.submitted.attachMode).toBe('identity');

          yield* broker.kill(separate.submitted.ticket);
          yield* broker.kill(merged.submitted.ticket);
          yield* Deferred.await(merged.exit).pipe(Effect.timeout('10 seconds'));
          yield* Deferred.await(separate.exit).pipe(Effect.timeout('10 seconds'));
        }),
      ).pipe(Effect.provide(layer));
    }));
});
