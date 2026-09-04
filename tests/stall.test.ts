import { join } from 'node:path';

import { describe, expect, it } from 'effect-rstest';
import * as Data from 'effect/Data';
import * as Deferred from 'effect/Deferred';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Queue from 'effect/Queue';
import * as Schedule from 'effect/Schedule';

import { Broker } from '../src/daemon/broker.js';
import type { BrokerApi } from '../src/daemon/broker.js';
import { resolveDaemonConfigWithWarnings } from '../src/daemon/config.js';
import type { ExitInfo, SubmitInput } from '../src/daemon/job-state.js';
import type { RequestRecord } from '../src/daemon/protocol.js';
import {
  StallProbe,
  evaluateStall,
  parseProcStat,
  parsePsCpuTime,
  parsePsTree,
  stalledKillReason,
  treeCpuMsFromStats,
  linuxTreeCpuMs,
} from '../src/daemon/stall.js';
import type { StallProbeShape } from '../src/daemon/stall.js';

import { brokerFixture } from './broker-fixture.js';
import type { Fixture } from './harness.js';

const minute = 60_000;

class NotYet extends Data.TaggedError('NotYet')<{ readonly status: string | undefined }> {}

describe('stall detection primitives', () => {
  it('parses /proc/<pid>/stat lines including a comm with spaces and parentheses', () => {
    const line =
      '4242 (rustc (main) x) S 4100 4242 4242 0 -1 4194560 100 0 0 0 1500 250 30 20 20 0 62 0 12345 0 0 18446744073709551615';
    expect(parseProcStat(line)).toEqual({ pid: 4242, ppid: 4100, cpuTicks: 1800 });
    expect(parseProcStat('garbage')).toBeNull();
  });

  it('sums CPU ticks over the descendant tree only, at 100 ticks per second', () => {
    const stats = [
      { pid: 1, ppid: 0, cpuTicks: 999_999 },
      { pid: 10, ppid: 1, cpuTicks: 100 },
      { pid: 11, ppid: 10, cpuTicks: 50 },
      { pid: 12, ppid: 11, cpuTicks: 25 },
      { pid: 20, ppid: 1, cpuTicks: 5_000 },
    ];
    expect(treeCpuMsFromStats(10, stats)).toBe(1_750);
    expect(treeCpuMsFromStats(11, stats)).toBe(750);
    expect(treeCpuMsFromStats(99, stats)).toBeNull();
  });

  it('parses ps cputime in every shape macOS prints', () => {
    expect(parsePsCpuTime('0:00.05')).toBe(50);
    expect(parsePsCpuTime('1:02.50')).toBe(62_500);
    expect(parsePsCpuTime('2:03:04')).toBe(2 * 3_600_000 + 3 * 60_000 + 4_000);
    expect(parsePsCpuTime('1-02:03:04.25')).toBe(
      86_400_000 + 2 * 3_600_000 + 3 * 60_000 + 4_250,
    );
    expect(parsePsCpuTime('nonsense')).toBeNull();
  });

  it('builds the process tree from ps output', () => {
    const output = [
      '    1     0 0:10.00',
      '  500     1 0:01.00',
      '  501   500 0:00.50',
      '  600     1 0:09.00',
      '',
    ].join('\n');
    expect(parsePsTree(output)).toEqual([
      { pid: 1, ppid: 0, cpuTicks: 1_000 },
      { pid: 500, ppid: 1, cpuTicks: 100 },
      { pid: 501, ppid: 500, cpuTicks: 50 },
      { pid: 600, ppid: 1, cpuTicks: 900 },
    ]);
  });

  it('reads this process tree on Linux', () => {
    if (process.platform !== 'linux') {
      return;
    }
    const sampled = linuxTreeCpuMs(process.pid);
    expect(sampled).not.toBeNull();
    expect(sampled ?? 0).toBeGreaterThan(0);
    expect(linuxTreeCpuMs(2 ** 22 - 1)).toBeNull();
  });

  it('flags a stall only once elapsed, idle CPU, and output silence all exceed their windows', () => {
    const thresholds = { estimateFactor: 3, idleMs: 10 * minute };
    const startedAtMs = 1_000_000;
    const baseline = evaluateStall(
      {
        cpuMs: 5_000,
        estimateMs: 5 * minute,
        lastOutputAtMs: startedAtMs,
        nowMs: startedAtMs,
        previous: null,
        startedAtMs,
        track: undefined,
      },
      thresholds,
    );
    expect(baseline.stall).toBeNull();
    expect(baseline.track).toEqual({ cpuMs: 5_000, progressAtMs: startedAtMs });

    // Elapsed and idle both exceed their windows, but output arrived recently.
    const talkative = evaluateStall(
      {
        cpuMs: 5_000,
        estimateMs: 5 * minute,
        lastOutputAtMs: startedAtMs + 19 * minute,
        nowMs: startedAtMs + 20 * minute,
        previous: null,
        startedAtMs,
        track: baseline.track,
      },
      thresholds,
    );
    expect(talkative.stall).toBeNull();

    // Idle long enough but the run is still inside 3× its estimate.
    const young = evaluateStall(
      {
        cpuMs: 5_000,
        estimateMs: 5 * minute,
        lastOutputAtMs: startedAtMs,
        nowMs: startedAtMs + 12 * minute,
        previous: null,
        startedAtMs,
        track: baseline.track,
      },
      thresholds,
    );
    expect(young.stall).toBeNull();

    const stalled = evaluateStall(
      {
        cpuMs: 5_000,
        estimateMs: 5 * minute,
        lastOutputAtMs: startedAtMs,
        nowMs: startedAtMs + 20 * minute,
        previous: null,
        startedAtMs,
        track: baseline.track,
      },
      thresholds,
    );
    expect(stalled.stall).toEqual({
      cpuMs: 5_000,
      idleMs: 20 * minute,
      since: startedAtMs + 20 * minute,
    });

    // Later samples keep the original `since` and grow the idle window.
    const later = evaluateStall(
      {
        cpuMs: 5_000,
        estimateMs: 5 * minute,
        lastOutputAtMs: startedAtMs,
        nowMs: startedAtMs + 25 * minute,
        previous: stalled.stall,
        startedAtMs,
        track: stalled.track,
      },
      thresholds,
    );
    expect(later.stall).toEqual({
      cpuMs: 5_000,
      idleMs: 25 * minute,
      since: startedAtMs + 20 * minute,
    });

    // Any change in tree CPU time (including a drop when a child exits) is progress.
    const busy = evaluateStall(
      {
        cpuMs: 4_000,
        estimateMs: 5 * minute,
        lastOutputAtMs: startedAtMs,
        nowMs: startedAtMs + 30 * minute,
        previous: later.stall,
        startedAtMs,
        track: later.track,
      },
      thresholds,
    );
    expect(busy.stall).toBeNull();
    expect(busy.track).toEqual({ cpuMs: 4_000, progressAtMs: startedAtMs + 30 * minute });
  });

  it('words the automatic kill reason in whole minutes', () => {
    expect(stalledKillReason(12 * minute + 30_000)).toBe(
      'stalled: no CPU for 12m after owner disconnected; killed automatically',
    );
  });

  it('reads the three stall variables from the environment', () => {
    const defaults = resolveDaemonConfigWithWarnings({}, 'linux').config;
    expect(defaults.stallEstimateFactor).toBe(3);
    expect(defaults.stallIdleMs).toBe(600_000);
    expect(defaults.stallAutoKill).toBe(true);

    const tuned = resolveDaemonConfigWithWarnings(
      {
        CARGO_HAULER_STALL_AUTO_KILL: 'off',
        CARGO_HAULER_STALL_ESTIMATE_FACTOR: '2.5',
        CARGO_HAULER_STALL_IDLE_MS: '120000',
      },
      'linux',
    );
    expect(tuned.warnings).toEqual([]);
    expect(tuned.config.stallEstimateFactor).toBe(2.5);
    expect(tuned.config.stallIdleMs).toBe(120_000);
    expect(tuned.config.stallAutoKill).toBe(false);

    const disabled = resolveDaemonConfigWithWarnings({ CARGO_HAULER_STALL_IDLE_MS: '0' }, 'linux');
    expect(disabled.config.stallIdleMs).toBeNull();

    const bad = resolveDaemonConfigWithWarnings(
      { CARGO_HAULER_STALL_ESTIMATE_FACTOR: 'lots' },
      'linux',
    );
    expect(bad.config.stallEstimateFactor).toBe(3);
    expect(bad.warnings[0]).toContain('CARGO_HAULER_STALL_ESTIMATE_FACTOR');
  });
});

/**
 * A stall probe the test drives by hand: the sampled CPU time, the clock
 * offset, and each sampling pass are all explicit, so no test waits ten
 * real minutes for the idle window.
 */
interface FakeProbe {
  readonly probe: StallProbeShape;
  readonly layer: Layer.Layer<never>;
  readonly tick: Effect.Effect<void>;
  readonly state: { cpuMs: number; offsetMs: number; samples: number; busy: boolean };
}

const fakeProbe = (): Effect.Effect<FakeProbe> =>
  Effect.gen(function* () {
    const ticks = yield* Queue.unbounded<void>();
    const state = { busy: false, cpuMs: 1_000, offsetMs: 0, samples: 0 };
    const probe: StallProbeShape = {
      nextSample: Queue.take(ticks),
      now: () => Date.now() + state.offsetMs,
      sampleTreeCpuMs: () =>
        Effect.sync(() => {
          state.samples += 1;
          if (state.busy) {
            state.cpuMs += 100;
          }
          return state.cpuMs;
        }),
    };
    return {
      layer: Layer.succeed(StallProbe, probe),
      probe,
      state,
      tick: Effect.asVoid(Queue.offer(ticks, undefined)),
    };
  });

const cargoEnv = (
  fixture: Fixture,
  extra: Readonly<Record<string, string>> = {},
): Record<string, string> => ({
  CARGO_HAULER_CARGO_BIN: join(fixture.binDir, 'cargo'),
  ...extra,
});

interface Tracked {
  readonly ticket: string;
  readonly started: Deferred.Deferred<void>;
  readonly exit: Deferred.Deferred<ExitInfo>;
}

const submitSleeper = (broker: BrokerApi, input: SubmitInput): Effect.Effect<Tracked, unknown> =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const exit = yield* Deferred.make<ExitInfo>();
    const submitted = yield* broker.submit(input, {
      onExit: (info) => Effect.asVoid(Deferred.succeed(exit, info)),
      onOutput: () => Effect.void,
      onStarted: () => Effect.asVoid(Deferred.succeed(started, undefined)),
    });
    return { exit, started, ticket: submitted.ticket };
  });

/** Drives sampling passes until `predicate` holds on the ticket's live record. */
const sampleUntil = (
  broker: BrokerApi,
  fake: FakeProbe,
  ticket: string,
  predicate: (record: RequestRecord | null, samples: number) => boolean,
): Effect.Effect<RequestRecord | null, unknown> =>
  Effect.gen(function* () {
    yield* fake.tick;
    yield* Effect.sleep('30 millis');
    const record = yield* broker.getTicket(ticket);
    if (!predicate(record, fake.state.samples)) {
      return yield* new NotYet({ status: record?.status });
    }
    return record;
  }).pipe(Effect.retry(Schedule.spaced('20 millis').pipe(Schedule.upTo({ times: 200 }))));

const sleeperInput = (fixture: Fixture): SubmitInput => ({
  argv: ['cargo', 'test', '-p', 'ws1'],
  cwd: fixture.ws1,
  env: cargoEnv(fixture, { FAKE_SLEEP: '30' }),
});

describe('stall detection on running leaders (#46)', () => {
  it.live('flags a stalled leader whose owner is still connected without killing it', () =>
    Effect.gen(function* () {
      const fake = yield* fakeProbe();
      const { fixture, layer } = yield* brokerFixture(1);
      yield* Effect.scoped(
        Effect.gen(function* () {
          const broker = yield* Broker;
          const job = yield* submitSleeper(broker, sleeperInput(fixture));
          yield* Deferred.await(job.started);
          // First pass records the CPU baseline once the child pid is known.
          yield* sampleUntil(broker, fake, job.ticket, (_, samples) => samples >= 1);

          fake.state.offsetMs = 60 * minute;
          const stalled = yield* sampleUntil(
            broker,
            fake,
            job.ticket,
            (record) => record?.stall !== undefined,
          );
          expect(stalled?.status).toBe('running');
          expect(stalled?.stall?.idleMs).toBeGreaterThanOrEqual(10 * minute);
          expect(stalled?.stall?.cpuMs).toBe(1_000);
          expect(stalled?.orphaned).toBeUndefined();

          // Owner connected: another pass leaves it running, only flagged.
          yield* fake.tick;
          yield* Effect.sleep('100 millis');
          const still = yield* broker.getTicket(job.ticket);
          expect(still?.status).toBe('running');
          expect(still?.stall).toBeDefined();

          yield* broker.kill(job.ticket);
          const exit = yield* Deferred.await(job.exit).pipe(Effect.timeout('10 seconds'));
          expect(exit.status).toBe('killed');
          expect(exit.error).toBeNull();
        }),
      ).pipe(Effect.provide(layer.pipe(Layer.provide(fake.layer))));
    }), 20_000);

  it.live('kills a stalled leader automatically once its owner has disconnected', () =>
    Effect.gen(function* () {
      const fake = yield* fakeProbe();
      const { fixture, layer } = yield* brokerFixture(1);
      yield* Effect.scoped(
        Effect.gen(function* () {
          const broker = yield* Broker;
          const job = yield* submitSleeper(broker, sleeperInput(fixture));
          yield* Deferred.await(job.started);
          yield* sampleUntil(broker, fake, job.ticket, (_, samples) => samples >= 1);
          expect(yield* broker.markOwnerGone(job.ticket)).toBe(true);
          const orphaned = yield* broker.getTicket(job.ticket);
          expect(orphaned?.orphaned).toBe(true);
          expect(orphaned?.stall).toBeUndefined();

          fake.state.offsetMs = 60 * minute;
          const settled = yield* sampleUntil(
            broker,
            fake,
            job.ticket,
            (record) => record?.status === 'killed',
          );
          expect(settled?.error).toBe(
            'stalled: no CPU for 60m after owner disconnected; killed automatically',
          );
          const exit = yield* Deferred.await(job.exit).pipe(Effect.timeout('10 seconds'));
          expect(exit.status).toBe('killed');
          expect(exit.error).toBe(
            'stalled: no CPU for 60m after owner disconnected; killed automatically',
          );
        }),
      ).pipe(Effect.provide(layer.pipe(Layer.provide(fake.layer))));
    }), 20_000);

  it.live('only flags an orphaned stall when CARGO_HAULER_STALL_AUTO_KILL is off', () =>
    Effect.gen(function* () {
      const fake = yield* fakeProbe();
      const { fixture, layer } = yield* brokerFixture(1, undefined, {
        CARGO_HAULER_STALL_AUTO_KILL: '0',
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const broker = yield* Broker;
          const job = yield* submitSleeper(broker, sleeperInput(fixture));
          yield* Deferred.await(job.started);
          yield* sampleUntil(broker, fake, job.ticket, (_, samples) => samples >= 1);
          yield* broker.markOwnerGone(job.ticket);

          fake.state.offsetMs = 60 * minute;
          const stalled = yield* sampleUntil(
            broker,
            fake,
            job.ticket,
            (record) => record?.stall !== undefined,
          );
          expect(stalled?.status).toBe('running');
          expect(stalled?.orphaned).toBe(true);
          yield* fake.tick;
          yield* Effect.sleep('100 millis');
          expect((yield* broker.getTicket(job.ticket))?.status).toBe('running');

          yield* broker.kill(job.ticket);
          yield* Deferred.await(job.exit).pipe(Effect.timeout('10 seconds'));
        }),
      ).pipe(Effect.provide(layer.pipe(Layer.provide(fake.layer))));
    }), 20_000);

  it.live('never flags a leader whose process tree keeps consuming CPU', () =>
    Effect.gen(function* () {
      const fake = yield* fakeProbe();
      fake.state.busy = true;
      const { fixture, layer } = yield* brokerFixture(1);
      yield* Effect.scoped(
        Effect.gen(function* () {
          const broker = yield* Broker;
          const job = yield* submitSleeper(broker, sleeperInput(fixture));
          yield* Deferred.await(job.started);
          yield* broker.markOwnerGone(job.ticket);
          yield* sampleUntil(broker, fake, job.ticket, (_, samples) => samples >= 1);

          fake.state.offsetMs = 60 * minute;
          yield* sampleUntil(broker, fake, job.ticket, (_, samples) => samples >= 4);
          const record = yield* broker.getTicket(job.ticket);
          expect(record?.status).toBe('running');
          expect(record?.stall).toBeUndefined();

          yield* broker.kill(job.ticket);
          yield* Deferred.await(job.exit).pipe(Effect.timeout('10 seconds'));
        }),
      ).pipe(Effect.provide(layer.pipe(Layer.provide(fake.layer))));
    }), 20_000);
});
