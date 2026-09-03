import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'effect-rstest';
import { Effect, Stream } from 'effect';

import { APP_RESOURCE_URI } from '../src/constants.js';
import {
  DEMUX_FLAG,
  argvText,
  argvTitle,
  attachSavings,
  compactArgvText,
  defaultMetricsWindowId,
  delayedWaitCue,
  diagnosticBadges,
  formatCompactNumber,
  formatMs,
  frequencyEntries,
  frequencyTotal,
  kacheColumns,
  kacheProfileGroups,
  laneIsActive,
  outputTextFor,
  pathBasename,
  percentileMinSamples,
  pickMetricsWindow,
  pollStatus,
  queuedWaitMs,
  queuedWaitThresholdMs,
  quietOutputHint,
  ranAsFor,
  relativeTime,
  remainingEstimateMs,
  remainingMinMs,
  resolveTicketDetail,
  rowSubcommand,
  runMetricsView,
  sectionOrder,
  shortenPath,
  subcommandDisplayLabel,
  subcommandMetricsView,
  subcommandTimings,
  summaryFirstLine,
  terminalStatuses,
  ticketDetailFrom,
  waitMetricsView,
  metricsWindowLabel,
  memoryStatView,
  admissionHoldDetail,
  heavyAdmissionNote,
} from '../src/dashboard/lib.js';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

describe('MCP App dashboard', () => {
  it('declares the widget URI and ships a self-contained artifact page', () => {
    expect(APP_RESOURCE_URI).toBe('ui://cargo-hauler/dashboard.html');
    for (const target of ['claude', 'codex', 'cursor', 'portable'] as const) {
      const built = join(repoRoot, 'artifact', target, 'mcp-apps', 'dashboard.html');
      expect(existsSync(built)).toBe(true);
      const html = readFileSync(built, 'utf8');
      expect(html).toContain('In flight');
      expect(html).toContain('History');
      expect(html).toContain('Contention');
      expect(html).toContain('hauler_status');
      expect(html).toContain('hauler_result');
      expect(html).toContain('wait exceeds estimate');
      expect(html).toContain('no output — long compile/link phases can be silent');
      expect(html).not.toContain('src="http');
    }
  });
});

describe('long-wait and quiet-output cues', () => {
  it('keeps delayed queue layout stable by rendering an optional compact cue', () => {
    expect(delayedWaitCue(true)).toBe('wait exceeds estimate');
    expect(delayedWaitCue(false)).toBeNull();
    expect(delayedWaitCue(undefined)).toBeNull();
  });

  it('formats quiet time with the documented diagnostic tooltip', () => {
    expect(quietOutputHint(5 * 60_000 + 1)).toEqual({
      label: 'quiet 5m',
      title: 'no output — long compile/link phases can be silent; check kache/rustc activity',
    });
    expect(quietOutputHint(undefined)).toBeNull();
  });
});

describe('pollStatus (one failed poll must not kill the stream)', () => {
  it.live('keeps polling through a failed iteration, surfacing then clearing the error', () =>
    Effect.gen(function* () {
      let call = 0;
      const fetch = Effect.suspend((): Effect.Effect<{ readonly seq: number }, string> => {
        call += 1;
        return call === 2
          ? Effect.fail('timed out: tools/call')
          : Effect.succeed({ seq: call });
      });
      const polls = yield* pollStatus(fetch, {
        describeError: (error) => error,
        interval: '1 millis',
        nowMs: () => 42,
      }).pipe(Stream.take(4), Stream.runCollect);
      expect(polls).toEqual([
        { error: null, updatedAtMs: 42, value: { seq: 1 } },
        // The failed poll keeps the last good status and carries the error…
        { error: 'timed out: tools/call', updatedAtMs: 42, value: { seq: 1 } },
        // …and the cadence continues: later successes clear it.
        { error: null, updatedAtMs: 42, value: { seq: 3 } },
        { error: null, updatedAtMs: 42, value: { seq: 4 } },
      ]);
    }));

  it.live('reports a first-poll failure without inventing a stale value', () =>
    Effect.gen(function* () {
      const polls = yield* pollStatus(Effect.fail('daemon gone'), {
        describeError: (error) => error,
        interval: '1 millis',
      }).pipe(Stream.take(2), Stream.runCollect);
      expect(polls).toEqual([
        { error: 'daemon gone', updatedAtMs: null, value: null },
        { error: 'daemon gone', updatedAtMs: null, value: null },
      ]);
    }));
});

describe('sectionOrder (stable layout)', () => {
  const fullOrder = [
    'contention',
    'inFlight',
    'queue',
    'metrics',
    'kache',
    'lanes',
    'history',
  ];

  it('keeps every section mounted so live polling never shifts layout', () => {
    expect(sectionOrder).toEqual(fullOrder);
  });
});

describe('pickMetricsWindow (window toggle and fallback)', () => {
  const windows = [
    {
      id: 'hour' as const,
      count: 3,
      done: 2,
      failed: 1,
      killed: 0,
      runP50Ms: 900,
      runP95Ms: 1_800,
      runMeanMs: 1_050,
      waitP50Ms: 40,
      waitP95Ms: 110,
      bySubcommand: [{ subcommand: 'check', count: 3, p50Ms: 900, maxMs: 1_800 }],
    },
    {
      id: 'day' as const,
      count: 12,
      done: 10,
      failed: 1,
      killed: 1,
      runP50Ms: 1_200,
      runP95Ms: 2_700,
      runMeanMs: 1_600,
      waitP50Ms: 70,
      waitP95Ms: 300,
      bySubcommand: [{ subcommand: 'check', count: 12, p50Ms: 1_200, maxMs: 2_700 }],
    },
    {
      id: 'all' as const,
      count: 55,
      done: 49,
      failed: 4,
      killed: 2,
      runP50Ms: 1_600,
      runP95Ms: 5_000,
      runMeanMs: 2_300,
      waitP50Ms: 120,
      waitP95Ms: 480,
      bySubcommand: [{ subcommand: 'check', count: 55, p50Ms: 1_600, maxMs: 5_000 }],
    },
  ];

  it('defaults to the documented 24h window id', () => {
    expect(defaultMetricsWindowId).toBe('day');
  });

  it('returns the selected window when present', () => {
    const picked = pickMetricsWindow(windows, 'all');
    expect(picked.source).toBe('ledger-windows');
    expect(picked.id).toBe('all');
    expect(picked.window?.count).toBe(55);
  });

  it('falls back to 24h when the selected id is missing', () => {
    const picked = pickMetricsWindow(windows.filter((window) => window.id !== 'all'), 'all');
    expect(picked.source).toBe('ledger-windows');
    expect(picked.id).toBe('day');
    expect(picked.window?.count).toBe(12);
  });

  it('falls back to daemon lifetime when windows are absent', () => {
    const picked = pickMetricsWindow(undefined, 'day');
    expect(picked).toEqual({
      id: 'day',
      source: 'daemon-lifetime',
      window: null,
    });
  });

  it('formats toggle labels', () => {
    expect(metricsWindowLabel('hour')).toBe('1h');
    expect(metricsWindowLabel('day')).toBe('24h');
    expect(metricsWindowLabel('all')).toBe('all');
  });
});

describe('remainingEstimateMs (no fake countdowns)', () => {
  it('hides remaining when the estimate has been reached or passed', () => {
    // The live busy dashboard showed elapsed 13s with "~13s" beside it.
    expect(remainingEstimateMs(13_000, 13_000)).toBeNull();
    expect(remainingEstimateMs(20_000, 13_000)).toBeNull();
  });

  it('hides remaining when the estimate is missing or a placeholder', () => {
    expect(remainingEstimateMs(13_000, undefined)).toBeNull();
    expect(remainingEstimateMs(13_000, null)).toBeNull();
    expect(remainingEstimateMs(13_000, 0)).toBeNull();
    expect(remainingEstimateMs(13_000, -1)).toBeNull();
  });

  it('hides remaining inside the minimum margin', () => {
    expect(remainingEstimateMs(60_000, 60_000 + remainingMinMs - 1)).toBeNull();
    // 10m estimate with 30s left: >= 5s but under 10% of the estimate.
    expect(remainingEstimateMs(9.5 * 60_000, 10 * 60_000)).toBeNull();
  });

  it('shows remaining when the estimate meaningfully exceeds elapsed', () => {
    expect(remainingEstimateMs(13_000, 102_000)).toBe(89_000);
    expect(remainingEstimateMs(0, 60_000)).toBe(60_000);
  });
});

describe('pathBasename (workspace column)', () => {
  it('keeps only the repo folder name', () => {
    expect(pathBasename('/fast/projects/tracedecay')).toBe('tracedecay');
    expect(pathBasename('/projects/tracedecay-plan40-stage3-sol')).toBe(
      'tracedecay-plan40-stage3-sol',
    );
  });

  it('handles trailing slashes and degenerate paths', () => {
    expect(pathBasename('/fast/projects/tracedecay/')).toBe('tracedecay');
    expect(pathBasename('tracedecay')).toBe('tracedecay');
    expect(pathBasename('/')).toBe('/');
  });
});

describe('kacheColumns (empty kache sub-panels collapse)', () => {
  it('renders no columns on an idle machine', () => {
    expect(kacheColumns({ crates: 0, roots: 0 })).toEqual([]);
  });

  it('drops only the empty side', () => {
    expect(kacheColumns({ crates: 7, roots: 0 })).toEqual(['crates']);
    expect(kacheColumns({ crates: 0, roots: 2 })).toEqual(['roots']);
    expect(kacheColumns({ crates: 7, roots: 2 })).toEqual(['roots', 'crates']);
  });
});

describe('remainingEstimateMs (no fake countdowns)', () => {
  it('hides remaining when the estimate has been reached or passed', () => {
    // The live busy dashboard showed elapsed 13s with "~13s" beside it.
    expect(remainingEstimateMs(13_000, 13_000)).toBeNull();
    expect(remainingEstimateMs(20_000, 13_000)).toBeNull();
  });

  it('hides remaining when the estimate is missing or a placeholder', () => {
    expect(remainingEstimateMs(13_000, undefined)).toBeNull();
    expect(remainingEstimateMs(13_000, null)).toBeNull();
    expect(remainingEstimateMs(13_000, 0)).toBeNull();
    expect(remainingEstimateMs(13_000, -1)).toBeNull();
  });

  it('hides remaining inside the minimum margin', () => {
    expect(remainingEstimateMs(60_000, 60_000 + remainingMinMs - 1)).toBeNull();
    // 10m estimate with 30s left: >= 5s but under 10% of the estimate.
    expect(remainingEstimateMs(9.5 * 60_000, 10 * 60_000)).toBeNull();
  });

  it('shows remaining when the estimate meaningfully exceeds elapsed', () => {
    expect(remainingEstimateMs(13_000, 102_000)).toBe(89_000);
    expect(remainingEstimateMs(0, 60_000)).toBe(60_000);
  });
});

describe('pathBasename (workspace column)', () => {
  it('keeps only the repo folder name', () => {
    expect(pathBasename('/fast/projects/tracedecay')).toBe('tracedecay');
    expect(pathBasename('/projects/tracedecay-plan40-stage3-sol')).toBe(
      'tracedecay-plan40-stage3-sol',
    );
  });

  it('handles trailing slashes and degenerate paths', () => {
    expect(pathBasename('/fast/projects/tracedecay/')).toBe('tracedecay');
    expect(pathBasename('tracedecay')).toBe('tracedecay');
    expect(pathBasename('/')).toBe('/');
  });
});

describe('kacheColumns (empty kache sub-panels collapse)', () => {
  it('renders no columns on an idle machine', () => {
    expect(kacheColumns({ crates: 0, roots: 0 })).toEqual([]);
  });

  it('drops only the empty side', () => {
    expect(kacheColumns({ crates: 7, roots: 0 })).toEqual(['crates']);
    expect(kacheColumns({ crates: 0, roots: 2 })).toEqual(['roots']);
    expect(kacheColumns({ crates: 7, roots: 2 })).toEqual(['roots', 'crates']);
  });
});

describe('runMetricsView (honest percentiles)', () => {
  const smallHistogram = {
    buckets: [
      [60_000, 1],
      [300_000, 3],
    ],
    count: 3,
    max: 250_000,
    min: 55_000,
    sum: 439_000,
  };

  it('always reports n and hides p95 below the sample threshold', () => {
    const view = runMetricsView(smallHistogram);
    expect(view.count).toBe(3);
    expect(view.p50Ms).toBe(300_000);
    expect(view.p95Ms).toBeNull();
    expect(view.meanMs).toBeCloseTo(439_000 / 3);
  });

  it('shows p95 once the histogram reaches the documented threshold', () => {
    const histogram = {
      buckets: [
        [1_000, 6],
        [5_000, percentileMinSamples],
      ],
      count: percentileMinSamples,
      max: 4_200,
      min: 300,
      sum: 24_000,
    };
    const view = runMetricsView(histogram);
    expect(view.p50Ms).toBe(1_000);
    expect(view.p95Ms).toBe(5_000);
  });

  it('stays gated one run below the threshold', () => {
    const histogram = {
      buckets: [[5_000, percentileMinSamples - 1]],
      count: percentileMinSamples - 1,
      max: 4_000,
      min: 100,
      sum: 9_000,
    };
    expect(runMetricsView(histogram).p95Ms).toBeNull();
  });

  it('returns an all-null view before any runs are tracked', () => {
    expect(runMetricsView(undefined)).toEqual({
      count: 0,
      meanMs: null,
      p50Ms: null,
      p95Ms: null,
    });
  });
});

describe('frequency metrics (zero is not a signal)', () => {
  it('drops zero counts so an idle attach_mode reads as no entries', () => {
    expect(frequencyEntries({ batch: 0, coverage: 0, identity: 0 })).toEqual([]);
    expect(frequencyTotal({ batch: 0, coverage: 0, identity: 0 })).toBe(0);
  });

  it('keeps real counts', () => {
    expect(frequencyEntries({ batch: 0, identity: 3 })).toEqual([['identity', 3]]);
    expect(frequencyTotal({ batch: 2, identity: 3 })).toBe(5);
  });
});

describe('ticket detail (click-through to cargo output)', () => {
  // Status rows from a running daemon: the broker nulls outputTail to keep
  // the report small, so terminal rows need one hauler_result follow-up.
  const statusRow = {
    argv: ['cargo', 'test', '-p', 'tracedecay-store-runtime'],
    error: null,
    errorCount: 2,
    exitCode: 101,
    outputTail: null,
    runMs: 5_300,
    status: 'failed',
    ticket: 'cc-702',
    waitMs: 13_000,
    warningCount: 0,
    workspaceRoot: '/projects/tracedecay-plan40-stage3-so',
  };

  it('fetches the stripped output tail via hauler_result for terminal rows', async () => {
    const calls: string[] = [];
    const detail = await resolveTicketDetail(statusRow, async (ticket) => {
      calls.push(ticket);
      return {
        ...statusRow,
        error: 'test failed in session_registry',
        outputTail: 'running 12 tests\ntest session_registry ... FAILED\nerror: test failed',
      };
    });
    expect(calls).toEqual(['cc-702']);
    expect(detail?.outputTail).toBe(
      'running 12 tests\ntest session_registry ... FAILED\nerror: test failed',
    );
    expect(detail?.error).toBe('test failed in session_registry');
    expect(detail?.exitCode).toBe(101);
  });

  it('uses the tail already on the row (stopped-daemon ledger path) without fetching', async () => {
    const detail = await resolveTicketDetail(
      { ...statusRow, outputTail: 'Finished `dev` profile in 3.2s' },
      async () => {
        throw new Error('should not fetch');
      },
    );
    expect(detail?.outputTail).toBe('Finished `dev` profile in 3.2s');
  });

  it('fetches for running rows too — the daemon overlays a live output snapshot', async () => {
    const calls: string[] = [];
    const detail = await resolveTicketDetail(
      { ...statusRow, outputTail: null, status: 'running' },
      async (ticket) => {
        calls.push(ticket);
        return {
          ...statusRow,
          status: 'running',
          outputTail: '   Compiling tracedecay v0.1.0',
          outputTailLive: true,
        };
      },
    );
    expect(calls).toEqual(['cc-702']);
    expect(detail?.status).toBe('running');
    expect(detail?.outputTail).toBe('   Compiling tracedecay v0.1.0');
    expect(detail?.outputTailLive).toBe(true);
  });

  it('marks outputTailLive false when the record does not carry the flag', () => {
    const detail = ticketDetailFrom({ ...statusRow, outputTail: 'done' });
    expect(detail?.outputTailLive).toBe(false);
  });

  it('falls back to the row detail when the ledger no longer has the ticket', async () => {
    const detail = await resolveTicketDetail(statusRow, async () => null);
    expect(detail?.ticket).toBe('cc-702');
    expect(detail?.outputTail).toBeNull();
  });

  it('rejects records without a ticket and normalizes missing fields', () => {
    expect(ticketDetailFrom({ status: 'done' })).toBeNull();
    expect(ticketDetailFrom(null)).toBeNull();
    const detail = ticketDetailFrom({ ticket: 'cc-1' });
    expect(detail).toMatchObject({ outputTail: null, status: 'unknown', ticket: 'cc-1' });
  });
});

describe('ranAsFor', () => {
  const argv = ['cargo', 'check', '-p', 'aa'];

  it('returns null when execArgv is absent (not yet run)', () => {
    expect(ranAsFor(argv, null)).toBeNull();
    expect(ranAsFor(argv, undefined)).toBeNull();
  });

  it('treats a demux-flag-only rewrite as noise', () => {
    expect(ranAsFor(argv, [...argv, DEMUX_FLAG])).toBeNull();
  });

  it('surfaces batch-folded packages with the extra count and no demux flag', () => {
    const execArgv = ['cargo', 'check', '-p', 'aa', '-p', 'bb', DEMUX_FLAG];
    expect(ranAsFor(argv, execArgv)).toEqual({
      command: 'cargo check -p aa -p bb',
      extraPackages: 1,
    });
  });

  it('counts --package= spellings and ignores packages already requested', () => {
    const execArgv = ['cargo', 'check', '-p', 'aa', '--package=bb', '--package', 'cc'];
    expect(ranAsFor(argv, execArgv)).toEqual({
      command: 'cargo check -p aa --package=bb --package cc',
      extraPackages: 2,
    });
  });

  it('reports a non-package difference with a zero extra count', () => {
    const execArgv = ['cargo', 'check', '-p', 'aa', '--all-features'];
    expect(ranAsFor(argv, execArgv)).toEqual({
      command: 'cargo check -p aa --all-features',
      extraPackages: 0,
    });
  });

  it('shows the bare program name even when the exec argv used an absolute path', () => {
    const absolute = ['/home/alice/.cargo/bin/cargo', 'test', '-p', 'aa'];
    expect(ranAsFor(argv, absolute)).toEqual({
      command: 'cargo test -p aa',
      extraPackages: 0,
    });
  });
});

describe('argvText', () => {
  it('strips the directory from the program while the title keeps it', () => {
    const argv = ['/home/alice/.cargo/bin/cargo', 'test', '-p', 'tracedecay-graph-db'];
    expect(argvText(argv)).toBe('cargo test -p tracedecay-graph-db');
    expect(argvTitle(argv)).toBe('/home/alice/.cargo/bin/cargo test -p tracedecay-graph-db');
  });

  it('passes plain commands through untouched', () => {
    expect(argvText(['cargo', 'check'])).toBe('cargo check');
    expect(argvText([])).toBe('');
    expect(argvText(null)).toBe('');
  });
});

describe('compactArgvText (bounded command cells)', () => {
  it('compacts one long nextest filterset with its top-level filter count', () => {
    const filterset = Array.from({ length: 21 }, (_, index) => `test(=case_${index})`).join(' | ');
    const argv = [
      'cargo',
      'nextest',
      'run',
      '-p',
      'tracedecay',
      '--test',
      'mcp_suite',
      '--features',
      'test-transport',
      '-E',
      filterset,
      '--no-fail-fast',
      '--test-threads=1',
    ];
    expect(compactArgvText(argv)).toBe(
      'cargo nextest run -p tracedecay --test mcp_suite --features test-transport -E (21 filters) --no-fail-fast --test-threads=1',
    );
    // The cell is compact, but the native tooltip remains the lossless path.
    expect(argvTitle(argv)).toBe(argv.join(' '));
  });

  it('leaves short commands and short filtersets untouched', () => {
    expect(compactArgvText(['cargo', 'check', '-p', 'graph'])).toBe(
      'cargo check -p graph',
    );
    expect(compactArgvText(['cargo', 'nextest', 'run', '-E', 'test(=one)'])).toBe(
      'cargo nextest run -E test(=one)',
    );
  });

  it('compacts long cargo test positional filter lists without hiding harness flags', () => {
    const filters = Array.from(
      { length: 21 },
      (_, index) => `integration_case_with_descriptive_name_${index}`,
    );
    expect(
      compactArgvText([
        'cargo',
        'test',
        '-p',
        'tracedecay',
        '--test',
        'mcp_suite',
        '--',
        ...filters,
        '--test-threads=1',
      ]),
    ).toBe(
      'cargo test -p tracedecay --test mcp_suite -- (21 filters) --test-threads=1',
    );
  });
});

describe('summaryFirstLine (bounded dashboard header)', () => {
  it('keeps only the compact status header when active-run details follow', () => {
    expect(
      summaryFirstLine(
        'cargo-hauler daemon is running; 1 active, 20 recent\ncc-2 running cargo test',
      ),
    ).toBe('cargo-hauler daemon is running; 1 active, 20 recent');
  });
});

describe('display formatting', () => {
  it('renders relative timestamps', () => {
    const now = 1_000_000_000;
    expect(relativeTime(now - 5_000, now)).toBe('5s ago');
    expect(relativeTime(now - 120_000, now)).toBe('2m ago');
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe('3h ago');
    expect(relativeTime(now - 2 * 86_400_000, now)).toBe('2d ago');
  });

  it('renders durations at readable precision', () => {
    expect(formatMs(420)).toBe('420ms');
    expect(formatMs(1_500)).toBe('1.5s');
    expect(formatMs(200_000)).toBe('3m 20s');
  });

  it('compacts durations at one hour and above', () => {
    expect(formatMs(27_110_000)).toBe('7h 31m');
    expect(formatMs(3_600_000)).toBe('1h');
    expect(formatMs(3_599_600)).toBe('1h');
  });

  it('carries rounded seconds into the minute instead of rendering 60s', () => {
    // A live dashboard showed "17m 60s" for 1079.6 seconds.
    expect(formatMs(1_079_600)).toBe('18m');
    expect(formatMs(119_800)).toBe('2m');
  });

  it('compacts large counts while keeping small counts exact', () => {
    expect(formatCompactNumber(999)).toBe('999');
    expect(formatCompactNumber(1_200)).toBe('1.2k');
    expect(formatCompactNumber(12_400)).toBe('12k');
    expect(formatCompactNumber(1_250_000)).toBe('1.3m');
  });

  it('shortens home-prefixed and overly long paths', () => {
    expect(shortenPath('/home/alice/proj/repo')).toBe('~/proj/repo');
    expect(shortenPath('/srv/some/deeply/nested/workspace/checkout/target/debug', 20)).toBe(
      '…/target/debug',
    );
  });
});

describe('memoryStatView', () => {
  it('formats MemAvailable with full PSI and clamp state', () => {
    expect(
      memoryStatView({
        memAvailableBytes: 44.2 * 1024 ** 3,
        memClamp: 'soft',
        memFullAvg10: 1.24,
      }),
    ).toEqual({
      clamp: 'soft',
      label: 'mem free · psi 1.2',
      value: '44.2 GB',
    });
  });

  it('keeps a stable placeholder for older daemons', () => {
    expect(memoryStatView({})).toEqual({
      clamp: 'none',
      label: 'mem free · psi —',
      value: '—',
    });
  });
});

describe('heavy admission cues', () => {
  it('notes the heavy count and cap only while relevant', () => {
    expect(
      heavyAdmissionNote({ heavy: { capActive: true, maxConcurrent: 1, running: 1 } }),
    ).toBe('1 heavy, cap 1 under low memory');
    expect(
      heavyAdmissionNote({ heavy: { capActive: false, maxConcurrent: 1, running: 2 } }),
    ).toBe('2 heavy');
    expect(heavyAdmissionNote({ heavy: { capActive: false, maxConcurrent: 1, running: 0 } })).toBeNull();
    expect(heavyAdmissionNote({})).toBeNull();
    expect(heavyAdmissionNote({ heavy: { running: 'many' } })).toBeNull();
  });

  it('extracts the hold detail defensively', () => {
    expect(admissionHoldDetail({ detail: 'load 3.10/core above 2.5/core', reason: 'load' })).toBe(
      'load 3.10/core above 2.5/core',
    );
    expect(admissionHoldDetail(undefined)).toBeNull();
    expect(admissionHoldDetail({ detail: '' })).toBeNull();
  });
});

describe('kacheProfileGroups (slowest crates never rank across profiles)', () => {
  const topCrates = [
    { crate: 'linker-heavy', ms: 90_000, profile: 'release' },
    { crate: 'proc-macros', ms: 20_000, profile: 'release' },
    { crate: 'graph-db', ms: 8_000, profile: 'dev' },
    { crate: 'store-runtime', ms: 3_000, profile: 'dev' },
    { crate: 'itest-suite', ms: 40_000, profile: 'test' },
  ];

  it('groups by profile with dev leading, each group sorted within itself', () => {
    const groups = kacheProfileGroups(topCrates);
    expect(groups.map((group) => group.profile)).toEqual(['dev', 'release', 'test']);
    expect(groups[0].rows).toEqual([
      { crate: 'graph-db', ms: 8_000 },
      { crate: 'store-runtime', ms: 3_000 },
    ]);
  });

  it('meters each group against its own maximum, never the global one', () => {
    const groups = kacheProfileGroups(topCrates);
    const dev = groups.find((group) => group.profile === 'dev');
    const release = groups.find((group) => group.profile === 'release');
    // A 90s release build must not flatten the dev group's meters.
    expect(dev?.maxMs).toBe(8_000);
    expect(release?.maxMs).toBe(90_000);
  });

  it('produces no group for profiles without valid timings', () => {
    expect(kacheProfileGroups([])).toEqual([]);
    expect(
      kacheProfileGroups([
        { crate: 'zeroed', ms: 0, profile: 'dev' },
        { crate: 42, ms: 1_000, profile: 'dev' },
      ]),
    ).toEqual([]);
  });

  it('appends unknown profiles after the familiar cargo ones', () => {
    const groups = kacheProfileGroups([
      { crate: 'a', ms: 1, profile: 'zcustom' },
      { crate: 'c', ms: 1, profile: '' },
      { crate: 'b', ms: 1, profile: 'release' },
    ]);
    expect(groups.map((group) => group.profile)).toEqual([
      'release',
      'unattributed',
      'zcustom',
    ]);
  });
});

describe('rowSubcommand (check and test are different populations)', () => {
  it('prefers the daemon-normalized intentJson subcommand', () => {
    expect(
      rowSubcommand({
        argv: ['cargo', 'whatever'],
        intentJson: JSON.stringify({ profile: 'dev', subcommand: 'nextest' }),
      }),
    ).toBe('nextest');
  });

  it('falls back to argv, skipping flags and toolchain selectors', () => {
    expect(rowSubcommand({ argv: ['cargo', 'check', '-p', 'aa'] })).toBe('check');
    expect(rowSubcommand({ argv: ['cargo', '+nightly', '--quiet', 'test'] })).toBe('test');
    expect(rowSubcommand({ argv: ['cargo'] })).toBeNull();
    expect(rowSubcommand({})).toBeNull();
  });

  it('survives malformed intentJson via the argv fallback', () => {
    expect(rowSubcommand({ argv: ['cargo', 'build'], intentJson: '{oops' })).toBe('build');
  });
});

describe('subcommandTimings (metrics split by subcommand)', () => {
  const rows = [
    { argv: ['cargo', 'check', '-p', 'aa'], runMs: 1_000 },
    { argv: ['cargo', 'check', '-p', 'bb'], runMs: 3_000 },
    { argv: ['cargo', 'check', '-p', 'cc'], runMs: 5_000 },
    { argv: ['cargo', 'test', '-p', 'aa'], runMs: 60_000 },
    { argv: ['cargo', 'test', '-p', 'bb'], runMs: 90_000 },
    // Rows without a duration (still running, denied) never count toward n.
    { argv: ['cargo', 'test', '-p', 'cc'], runMs: null },
  ];

  it('reports each subcommand as its own population with an honest n', () => {
    const timings = subcommandTimings(rows);
    expect(timings).toEqual([
      {
        count: 3,
        maxMs: 5_000,
        meanMs: 3_000,
        p50Ms: 3_000,
        profile: 'dev',
        subcommand: 'check',
      },
      {
        count: 2,
        maxMs: 90_000,
        meanMs: 75_000,
        p50Ms: 60_000,
        profile: 'test',
        subcommand: 'test',
      },
    ]);
  });

  it('never blends check and test into one line', () => {
    const timings = subcommandTimings(rows);
    const check = timings.find((timing) => timing.subcommand === 'check');
    // A blended p50 over all five runs would be 5s; the honest check p50 is 3s.
    expect(check?.p50Ms).toBe(3_000);
    expect(timings).toHaveLength(2);
  });

  it('keeps custom profiles separate and labels only the non-default profile', () => {
    const timings = subcommandTimings([
      {
        intentJson: JSON.stringify({ profile: 'dev', subcommand: 'build' }),
        runMs: 1_000,
      },
      {
        intentJson: JSON.stringify({ profile: 'perf', subcommand: 'build' }),
        runMs: 9_000,
      },
    ]);

    expect(timings.map((timing) => [timing.profile, timing.p50Ms])).toEqual([
      ['dev', 1_000],
      ['perf', 9_000],
    ]);
    expect(timings.map(subcommandDisplayLabel)).toEqual(['cargo build', 'cargo build · perf']);
  });
});

describe('waitMetricsView (daemon summary + fallback)', () => {
  it('prefers daemon summary quantiles when provided', () => {
    const metrics = waitMetricsView(
      {
        count: 12,
        max: 9_000,
        quantiles: [
          [0.5, 1_000],
          [0.9, 4_000],
          [0.95, 8_000],
        ],
      },
      [400, 600, 800],
    );
    expect(metrics).toEqual({
      source: 'daemon-1h',
      count: 12,
      p50Ms: 1_000,
      p90Ms: 4_000,
      p95Ms: 8_000,
      maxMs: 9_000,
    });
  });

  it('falls back to visible finished rows when summary is absent', () => {
    const metrics = waitMetricsView(undefined, [5_000, 1_000, 3_000]);
    expect(metrics).toEqual({
      source: 'visible-window',
      count: 3,
      p50Ms: 3_000,
      p90Ms: null,
      p95Ms: null,
      maxMs: 5_000,
    });
  });
});

describe('subcommandMetricsView (daemon-lifetime + fallback)', () => {
  it('prefers daemon per-kind histograms when available', () => {
    const view = subcommandMetricsView(
      {
        check: {
          buckets: [
            [1_000, 2],
            [5_000, 3],
          ],
          count: 3,
          min: 800,
          max: 4_500,
          sum: 8_000,
        },
        test: {
          buckets: [
            [60_000, 1],
            [120_000, 1],
          ],
          count: 1,
          min: 60_000,
          max: 60_000,
          sum: 60_000,
        },
      },
      [{ argv: ['cargo', 'build'], runMs: 2_000 }],
    );
    expect(view.source).toBe('daemon-lifetime');
    expect(view.rows).toEqual([
      {
        count: 3,
        maxMs: 4_500,
        meanMs: 8_000 / 3,
        p50Ms: 1_000,
        profile: 'dev',
        subcommand: 'check',
      },
      {
        count: 1,
        maxMs: 60_000,
        meanMs: 60_000,
        p50Ms: 60_000,
        profile: 'test',
        subcommand: 'test',
      },
    ]);
  });

  it('falls back to visible-window subcommand timings for older daemons', () => {
    const rows = [
      { argv: ['cargo', 'check', '-p', 'aa'], runMs: 1_000 },
      { argv: ['cargo', 'test', '-p', 'aa'], runMs: 60_000 },
    ];
    const view = subcommandMetricsView(undefined, rows);
    expect(view.source).toBe('visible-window');
    expect(view.rows).toEqual(subcommandTimings(rows));
  });
});

describe('diagnosticBadges (history/in-flight warning and error counts)', () => {
  it('renders nothing for unknown or zero counts', () => {
    expect(diagnosticBadges(null, null)).toEqual([]);
    expect(diagnosticBadges(0, 0)).toEqual([]);
    expect(diagnosticBadges(undefined, undefined)).toEqual([]);
  });

  it('emits errors before warnings with their counts', () => {
    expect(diagnosticBadges(2, 5)).toEqual([
      { count: 2, kind: 'errors' },
      { count: 5, kind: 'warnings' },
    ]);
    expect(diagnosticBadges(0, 3)).toEqual([{ count: 3, kind: 'warnings' }]);
  });
});

describe('terminal statuses', () => {
  it('includes hook-denied and fail-open passthrough attempts as finished work', () => {
    expect([...terminalStatuses].sort()).toEqual([
      'denied',
      'done',
      'failed',
      'killed',
      'passthrough',
    ]);
  });

  it('does not re-fetch output for denied rows once resolved', async () => {
    const calls: string[] = [];
    await resolveTicketDetail(
      { outputTail: null, status: 'denied', ticket: 'cc-9' },
      async (ticket) => {
        calls.push(ticket);
        return null;
      },
    );
    // Denied is terminal, so the drawer is allowed one result fetch.
    expect(calls).toEqual(['cc-9']);
  });
});

describe('queuedWaitMs (in-flight rows that queued first)', () => {
  it('surfaces waits from the documented threshold up', () => {
    expect(queuedWaitMs(queuedWaitThresholdMs)).toBe(queuedWaitThresholdMs);
    expect(queuedWaitMs(8_000)).toBe(8_000);
  });

  it('hides sub-threshold bookkeeping waits and non-numbers', () => {
    expect(queuedWaitMs(queuedWaitThresholdMs - 1)).toBeNull();
    expect(queuedWaitMs(0)).toBeNull();
    expect(queuedWaitMs(null)).toBeNull();
    expect(queuedWaitMs(undefined)).toBeNull();
  });
});

describe('outputTextFor (drawer diagnostics fallback)', () => {
  const base = ticketDetailFrom({ ticket: 'cc-1', status: 'failed' });

  it('prefers the output tail when present', () => {
    const detail = ticketDetailFrom({
      diagnostics: ['warning: unused import'],
      outputTail: 'Compiling…',
      status: 'failed',
      ticket: 'cc-1',
    });
    expect(detail === null ? null : outputTextFor(detail)).toBe('Compiling…');
  });

  it('renders the ledger diagnostics when the tail is null (live daemon nulls it)', () => {
    const detail = ticketDetailFrom({
      diagnostics: ['error[E0308]: mismatched types', 'warning: unused import'],
      outputTail: null,
      status: 'failed',
      ticket: 'cc-1',
    });
    expect(detail === null ? null : outputTextFor(detail)).toBe(
      'error[E0308]: mismatched types\n\nwarning: unused import',
    );
  });

  it('yields null when neither tail nor diagnostics exist', () => {
    expect(base === null ? 'missing' : outputTextFor(base)).toBeNull();
    const empty = ticketDetailFrom({ diagnostics: [], status: 'done', ticket: 'cc-2' });
    expect(empty === null ? 'missing' : outputTextFor(empty)).toBeNull();
  });
});

describe('laneIsActive (idle lanes collapse)', () => {
  it('keeps lanes holding work', () => {
    expect(laneIsActive({ queued: 2, runningTicket: null })).toBe(true);
    expect(laneIsActive({ queued: 0, runningTicket: 'cc-4' })).toBe(true);
  });

  it('drops lanes with nothing running and nothing queued', () => {
    expect(laneIsActive({ queued: 0, runningTicket: null })).toBe(false);
    expect(laneIsActive({})).toBe(false);
  });
});

describe('attachSavings (runs avoided is attach coalescing, not kache)', () => {
  it('bounds coverage credit by the follower estimate', () => {
    const savings = attachSavings([
      { attachedTo: null, runMs: 42_000, ticket: 'cc-1' },
      { attachMode: 'identity', attachedTo: 'cc-1', estimateMs: 39_000, ticket: 'cc-2' },
      { attachMode: 'coverage', attachedTo: 'cc-1', estimateMs: 10_000, ticket: 'cc-3' },
    ]);
    expect(savings.avoidedRuns).toBe(2);
    expect(savings.savedExactMs).toBe(42_000);
    expect(savings.savedEstimatedMs).toBe(10_000);
  });

  it('falls back to the follower estimate, kept separate as estimated', () => {
    const savings = attachSavings([
      { attachedTo: null, runMs: null, ticket: 'cc-1' },
      { attachMode: 'identity', attachedTo: 'cc-1', estimateMs: 39_000, ticket: 'cc-2' },
      { attachMode: 'batch', attachedTo: 'cc-9', estimateMs: 5_000, ticket: 'cc-3' },
    ]);
    expect(savings.savedExactMs).toBe(0);
    expect(savings.savedEstimatedMs).toBe(44_000);
    expect(savings.avoidedRuns).toBe(2);
  });

  it('deduplicates active/recent overlap by ticket before totaling', () => {
    const savings = attachSavings([
      { attachedTo: null, runMs: 20_000, ticket: 'cc-1' },
      { attachMode: 'identity', attachedTo: 'cc-1', estimateMs: 20_000, ticket: 'cc-2' },
      // Same ticket appears in the second list (active + recent concat overlap).
      { attachMode: 'identity', attachedTo: 'cc-1', estimateMs: 20_000, ticket: 'cc-2' },
    ]);
    expect(savings.avoidedRuns).toBe(1);
    expect(savings.savedExactMs).toBe(20_000);
    expect(savings.savedEstimatedMs).toBe(0);
  });

  it('counts packages folded into visible batch leaders', () => {
    const savings = attachSavings([
      {
        argv: ['cargo', 'check', '-p', 'aa'],
        attachedTo: null,
        execArgv: ['cargo', 'check', '-p', 'aa', '-p', 'bb', '-p', 'cc', DEMUX_FLAG],
        ticket: 'cc-1',
      },
    ]);
    expect(savings.batchExtraPackages).toBe(2);
    expect(savings.avoidedRuns).toBe(0);
  });

  it('derives nothing from kache-shaped compile timings', () => {
    // Kache topCrates rows carry crate/ms/profile — no attach fields. Feeding
    // them in must produce zero savings: crate build cost is not hauler
    // savings, and the two must never be conflated.
    const savings = attachSavings([
      { crate: 'linker-heavy', ms: 90_000, profile: 'release' } as never,
      { crate: 'graph-db', ms: 8_000, profile: 'dev' } as never,
    ]);
    expect(savings).toEqual({
      avoidedRuns: 0,
      batchExtraPackages: 0,
      savedEstimatedMs: 0,
      savedExactMs: 0,
    });
  });
});
