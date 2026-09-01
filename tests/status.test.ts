import { homedir } from 'node:os';
import { join, sep } from 'node:path';

import { describe, expect, it } from '@rstest/core';

import { resolveDaemonConfig } from '../src/daemon/config.js';
import { resolveHookStateDir } from '../src/hooks/paths.js';
import {
  defaultKacheIndexPath,
  defaultStateDir,
  resolveStateDir,
  userCacheDir,
} from '../src/status.js';

describe('portable state root', () => {
  it('defaults under the invoking user cache, never a machine-specific mount', () => {
    const stateDir = defaultStateDir({});
    expect(stateDir.startsWith(`/fast${sep}`)).toBe(false);
    expect(stateDir.startsWith(homedir())).toBe(true);
    expect(stateDir.endsWith(`${sep}cargo-conductor`)).toBe(true);
  });

  it('honors XDG_CACHE_HOME on every platform', () => {
    const env = { XDG_CACHE_HOME: '/tmp/xdg-cache' };
    expect(defaultStateDir(env, 'linux', '/home/alice')).toBe('/tmp/xdg-cache/cargo-conductor');
    expect(defaultStateDir(env, 'darwin', '/Users/alice')).toBe('/tmp/xdg-cache/cargo-conductor');
  });

  it('uses each platform cache convention when XDG_CACHE_HOME is unset', () => {
    expect(defaultStateDir({}, 'linux', '/home/alice')).toBe(
      join('/home/alice', '.cache', 'cargo-conductor'),
    );
    expect(defaultStateDir({}, 'darwin', '/Users/alice')).toBe(
      join('/Users/alice', 'Library', 'Caches', 'cargo-conductor'),
    );
    expect(defaultStateDir({ LOCALAPPDATA: 'C:\\Users\\alice\\AppData\\Local' }, 'win32', 'C:\\Users\\alice')).toBe(
      join('C:\\Users\\alice\\AppData\\Local', 'cargo-conductor'),
    );
    expect(defaultStateDir({}, 'win32', 'C:\\Users\\alice')).toBe(
      join('C:\\Users\\alice', 'AppData', 'Local', 'cargo-conductor'),
    );
  });

  it('lets CARGO_CONDUCTOR_STATE_DIR override everywhere the state dir is resolved', () => {
    const env = { CARGO_CONDUCTOR_STATE_DIR: '/fast/cache/cargo-conductor' };
    expect(resolveStateDir(env)).toBe('/fast/cache/cargo-conductor');
    expect(resolveDaemonConfig(env).stateDir).toBe('/fast/cache/cargo-conductor');
    expect(resolveHookStateDir(env)).toBe('/fast/cache/cargo-conductor');
  });

  it('keeps daemon config and hook clients on the same default', () => {
    const env = {};
    const config = resolveDaemonConfig(env);
    expect(config.stateDir).toBe(resolveHookStateDir(env));
    expect(config.stateDir).toBe(defaultStateDir(env));
    expect(config.socketPath).toBe(join(config.stateDir, 'daemon.sock'));
  });
});

describe('portable kache index default', () => {
  it('defaults to a kache sibling under the same user cache base', () => {
    expect(defaultKacheIndexPath({}, 'linux', '/home/alice')).toBe(
      join('/home/alice', '.cache', 'kache', 'index.db'),
    );
    expect(defaultKacheIndexPath({}, 'linux', '/home/alice')).toBe(
      join(userCacheDir({}, 'linux', '/home/alice'), 'kache', 'index.db'),
    );
    expect(resolveDaemonConfig({}).kacheIndexPath.startsWith(`/fast${sep}`)).toBe(false);
  });

  it('prefers CARGO_CONDUCTOR_KACHE_INDEX and keeps empty string as disable', () => {
    expect(
      resolveDaemonConfig({ CARGO_CONDUCTOR_KACHE_INDEX: '/fast/cache/kache/index.db' })
        .kacheIndexPath,
    ).toBe('/fast/cache/kache/index.db');
    expect(resolveDaemonConfig({ CARGO_CONDUCTOR_KACHE_INDEX: '' }).kacheIndexPath).toBe('');
  });
});
