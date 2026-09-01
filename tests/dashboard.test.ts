import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from '@rstest/core';

import { APP_RESOURCE_URI } from '../src/constants.js';
import {
  DEMUX_FLAG,
  argvText,
  argvTitle,
  formatMs,
  ranAsFor,
  relativeTime,
  shortenPath,
  startPolling,
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
      expect(html).not.toContain('src="http');
    }
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

describe('startPolling', () => {
  it('loads immediately, then schedules the poll interval', async () => {
    const calls: string[] = [];
    let scheduled: { readonly callback: () => void; readonly intervalMs: number } | null = null;
    startPolling(
      async () => {
        calls.push('load');
      },
      (callback, intervalMs) => {
        scheduled = { callback, intervalMs };
      },
      5_000,
    );
    expect(calls).toEqual(['load']);
    expect(scheduled).not.toBeNull();
    expect(scheduled!.intervalMs).toBe(5_000);
    scheduled!.callback();
    await Promise.resolve();
    expect(calls).toEqual(['load', 'load']);
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

  it('shortens home-prefixed and overly long paths', () => {
    expect(shortenPath('/home/zack/proj/repo')).toBe('~/proj/repo');
    expect(shortenPath('/fast/some/deeply/nested/workspace/checkout/target/debug', 20)).toBe(
      '…/target/debug',
    );
  });
});
