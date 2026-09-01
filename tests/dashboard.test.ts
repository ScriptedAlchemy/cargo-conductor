import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from '@rstest/core';

import { APP_RESOURCE_URI } from '../src/constants.js';
import {
  DEMUX_FLAG,
  argvText,
  argvTitle,
  formatCompactNumber,
  formatMs,
  frequencyEntries,
  frequencyTotal,
  percentileMinSamples,
  ranAsFor,
  relativeTime,
  resolveTicketDetail,
  runMetricsView,
  sectionOrder,
  shortenPath,
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
    const absolute = ['/home/zack/.cargo/bin/cargo', 'test', '-p', 'aa'];
    expect(ranAsFor(argv, absolute)).toEqual({
      command: 'cargo test -p aa',
      extraPackages: 0,
    });
  });
});

describe('argvText', () => {
  it('strips the directory from the program while the title keeps it', () => {
    const argv = ['/home/zack/.cargo/bin/cargo', 'test', '-p', 'tracedecay-graph-db'];
    expect(argvText(argv)).toBe('cargo test -p tracedecay-graph-db');
    expect(argvTitle(argv)).toBe('/home/zack/.cargo/bin/cargo test -p tracedecay-graph-db');
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
    expect(shortenPath('/home/zack/proj/repo')).toBe('~/proj/repo');
    expect(shortenPath('/fast/some/deeply/nested/workspace/checkout/target/debug', 20)).toBe(
      '…/target/debug',
    );
  });
});
