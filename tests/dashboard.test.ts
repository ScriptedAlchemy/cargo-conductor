import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from '@rstest/core';

import { APP_RESOURCE_URI } from '../src/constants.js';
import {
  DEMUX_FLAG,
  argvText,
  argvTitle,
  attachSavings,
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
  queuedWaitMs,
  queuedWaitThresholdMs,
  ranAsFor,
  relativeTime,
  remainingEstimateMs,
  remainingMinMs,
  resolveTicketDetail,
  rowSubcommand,
  runMetricsView,
  sectionOrder,
  shortenPath,
  subcommandTimings,
  terminalStatuses,
  ticketDetailFrom,
} from '../views/dashboard-lib.js';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

describe('MCP App dashboard', () => {
  it('declares the widget URI and ships a self-contained artifact page', () => {
    expect(APP_RESOURCE_URI).toBe('ui://cargo-conductor/dashboard.html');
    for (const target of ['plugin', 'portable'] as const) {
      const built = join(repoRoot, 'artifact', target, 'mcp-apps', 'dashboard.html');
      expect(existsSync(built)).toBe(true);
      const html = readFileSync(built, 'utf8');
      expect(html).toContain('In flight');
      expect(html).toContain('History');
      expect(html).toContain('Contention');
      expect(html).toContain('conductor_status');
      expect(html).toContain('conductor_result');
      expect(html).not.toContain('src="http');
    }
  });
});

describe('sectionOrder (empty-section collapse)', () => {
  it('collapses In flight, Queue, and Lanes on the idle home', () => {
    expect(sectionOrder({ lanes: 0, queued: 0, running: 0 })).toEqual([
      'contention',
      'metrics',
      'kache',
      'history',
    ]);
  });

  it('puts In flight first in the body, above Queue, when work is running', () => {
    expect(sectionOrder({ lanes: 2, queued: 1, running: 3 })).toEqual([
      'contention',
      'inFlight',
      'queue',
      'metrics',
      'kache',
      'lanes',
      'history',
    ]);
  });

  it('shows Queue without In flight when everything is still waiting', () => {
    expect(sectionOrder({ lanes: 1, queued: 4, running: 0 })).toEqual([
      'contention',
      'queue',
      'metrics',
      'kache',
      'lanes',
      'history',
    ]);
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
  // the report small, so terminal rows need one conductor_result follow-up.
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

  it('fetches the stripped output tail via conductor_result for terminal rows', async () => {
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

  it('does not fetch for rows that have not finished (no tail exists yet)', async () => {
    const detail = await resolveTicketDetail(
      { ...statusRow, outputTail: null, status: 'running' },
      async () => {
        throw new Error('should not fetch');
      },
    );
    expect(detail?.status).toBe('running');
    expect(detail?.outputTail).toBeNull();
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
      { crate: 'b', ms: 1, profile: 'release' },
    ]);
    expect(groups.map((group) => group.profile)).toEqual(['release', 'zcustom']);
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
      { count: 3, maxMs: 5_000, meanMs: 3_000, p50Ms: 3_000, subcommand: 'check' },
      { count: 2, maxMs: 90_000, meanMs: 75_000, p50Ms: 60_000, subcommand: 'test' },
    ]);
  });

  it('never blends check and test into one line', () => {
    const timings = subcommandTimings(rows);
    const check = timings.find((timing) => timing.subcommand === 'check');
    // A blended p50 over all five runs would be 5s; the honest check p50 is 3s.
    expect(check?.p50Ms).toBe(3_000);
    expect(timings).toHaveLength(2);
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

describe('terminal statuses (denied is its own distinct end)', () => {
  it('treats denied as finished work alongside done, failed, and killed', () => {
    expect([...terminalStatuses].sort()).toEqual(['denied', 'done', 'failed', 'killed']);
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
  it('credits the leader real runtime once per follower when the leader finished', () => {
    const savings = attachSavings([
      { attachedTo: null, runMs: 42_000, ticket: 'cc-1' },
      { attachMode: 'identity', attachedTo: 'cc-1', estimateMs: 39_000, ticket: 'cc-2' },
      { attachMode: 'coverage', attachedTo: 'cc-1', estimateMs: 10_000, ticket: 'cc-3' },
    ]);
    expect(savings.avoidedRuns).toBe(2);
    expect(savings.savedExactMs).toBe(84_000);
    expect(savings.savedEstimatedMs).toBe(0);
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
    // them in must produce zero savings: crate build cost is not conductor
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
