import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, sep } from 'node:path';

import { describe, expect, it } from '@rstest/core';

import { resolveDaemonConfig } from '../src/daemon/config.js';
import { resolveHookSocketPath, resolveHookStateDir } from '../src/hooks/paths.js';
import {
  daemonSocketPath,
  defaultKacheIndexPath,
  defaultStateDir,
  isNamedPipePath,
  resolveStateDir,
  userCacheDir,
} from '../src/status.js';

describe('portable state root', () => {
  it('defaults under the invoking user cache, never a machine-specific mount', () => {
    const stateDir = defaultStateDir({});
    expect(stateDir.startsWith(`/fast${sep}`)).toBe(false);
    expect(stateDir.startsWith(homedir())).toBe(true);
    expect(stateDir.endsWith(`${sep}cargo-hauler`)).toBe(true);
  });

  it('honors XDG_CACHE_HOME on every platform', () => {
    const env = { XDG_CACHE_HOME: '/tmp/xdg-cache' };
    expect(defaultStateDir(env, 'linux', '/home/alice')).toBe('/tmp/xdg-cache/cargo-hauler');
    expect(defaultStateDir(env, 'darwin', '/Users/alice')).toBe('/tmp/xdg-cache/cargo-hauler');
  });

  it('uses each platform cache convention when XDG_CACHE_HOME is unset', () => {
    expect(defaultStateDir({}, 'linux', '/home/alice')).toBe(
      join('/home/alice', '.cache', 'cargo-hauler'),
    );
    expect(defaultStateDir({}, 'darwin', '/Users/alice')).toBe(
      join('/Users/alice', 'Library', 'Caches', 'cargo-hauler'),
    );
    expect(defaultStateDir({ LOCALAPPDATA: 'C:\\Users\\alice\\AppData\\Local' }, 'win32', 'C:\\Users\\alice')).toBe(
      join('C:\\Users\\alice\\AppData\\Local', 'cargo-hauler'),
    );
    expect(defaultStateDir({}, 'win32', 'C:\\Users\\alice')).toBe(
      join('C:\\Users\\alice', 'AppData', 'Local', 'cargo-hauler'),
    );
  });

  it('lets CARGO_HAULER_STATE_DIR override everywhere the state dir is resolved', () => {
    const env = { CARGO_HAULER_STATE_DIR: '/fast/cache/cargo-hauler' };
    expect(resolveStateDir(env)).toBe('/fast/cache/cargo-hauler');
    expect(resolveDaemonConfig(env).stateDir).toBe('/fast/cache/cargo-hauler');
    expect(resolveHookStateDir(env)).toBe('/fast/cache/cargo-hauler');
  });

  it('falls back to the legacy state dir while preferring the hauler variable', () => {
    const legacy = { CARGO_CONDUCTOR_STATE_DIR: '/fast/cache/cargo-conductor' };
    expect(resolveStateDir(legacy)).toBe('/fast/cache/cargo-conductor');
    expect(resolveDaemonConfig(legacy).stateDir).toBe('/fast/cache/cargo-conductor');
    expect(resolveHookStateDir(legacy)).toBe('/fast/cache/cargo-conductor');

    expect(
      resolveStateDir({
        CARGO_CONDUCTOR_STATE_DIR: '/legacy',
        CARGO_HAULER_STATE_DIR: '/current',
      }),
    ).toBe('/current');
  });

  it('treats an empty hauler override as unset before consulting the legacy variable', () => {
    const env = {
      CARGO_CONDUCTOR_STATE_DIR: '/legacy',
      CARGO_HAULER_STATE_DIR: '',
    };
    expect(resolveStateDir(env)).toBe('/legacy');
    expect(resolveDaemonConfig(env).stateDir).toBe('/legacy');
    expect(resolveHookStateDir(env)).toBe('/legacy');
  });

  it('never selects a legacy directory merely because it exists', () => {
    const cacheRoot = mkdtempSync(join(tmpdir(), 'cargo-hauler-state-resolution-'));
    const legacyDir = join(cacheRoot, 'cargo-conductor');
    mkdirSync(legacyDir);
    try {
      const env = { XDG_CACHE_HOME: cacheRoot };
      const expected = join(cacheRoot, 'cargo-hauler');
      expect(resolveStateDir(env)).toBe(expected);
      expect(resolveDaemonConfig(env).stateDir).toBe(expected);
      expect(resolveHookStateDir(env)).toBe(expected);
    } finally {
      rmSync(cacheRoot, { recursive: true, force: true });
    }
  });

  it('keeps daemon config and hook clients on the same default', () => {
    const env = {};
    const config = resolveDaemonConfig(env);
    expect(config.stateDir).toBe(resolveHookStateDir(env));
    expect(config.stateDir).toBe(defaultStateDir(env));
    expect(config.socketPath).toBe(join(config.stateDir, 'daemon.sock'));
  });
});

describe('daemon control endpoint per platform', () => {
  const winEnv = { LOCALAPPDATA: 'C:\\Users\\alice\\AppData\\Local' };

  it('keeps a unix socket file inside the state dir on darwin and linux', () => {
    expect(daemonSocketPath('/home/alice/.cache/cargo-hauler', 'linux')).toBe(
      join('/home/alice/.cache/cargo-hauler', 'daemon.sock'),
    );
    expect(daemonSocketPath('/Users/alice/Library/Caches/cargo-hauler', 'darwin')).toBe(
      join('/Users/alice/Library/Caches/cargo-hauler', 'daemon.sock'),
    );
    expect(isNamedPipePath(daemonSocketPath('/tmp/state', 'linux'))).toBe(false);
  });

  it('listens on a \\\\.\\pipe\\ named pipe on win32, never a filesystem .sock path', () => {
    const config = resolveDaemonConfig(winEnv, 'win32');
    // Node net.Server.listen treats a path as Windows IPC only under the
    // named-pipe namespace; a %LOCALAPPDATA%\...\daemon.sock path cannot be
    // bound, so the daemon could never start on the documented default.
    expect(config.socketPath).toMatch(/^\\\\\.\\pipe\\cargo-hauler-[0-9a-f]{16}$/u);
    expect(isNamedPipePath(config.socketPath)).toBe(true);
    expect(config.socketPath).not.toContain('daemon.sock');
    // Non-socket state files stay in the filesystem state dir.
    expect(config.databasePath).toBe(join(config.stateDir, 'ledger.db'));
  });

  it('gives daemon and hook clients the same pipe for the same state dir', () => {
    const config = resolveDaemonConfig(winEnv, 'win32');
    expect(resolveHookSocketPath(winEnv, 'win32')).toBe(config.socketPath);
    expect(resolveDaemonConfig(winEnv, 'win32').socketPath).toBe(config.socketPath);
  });

  it('keeps the pipe stable per state dir and distinct across state dirs', () => {
    const one = daemonSocketPath('C:\\Users\\alice\\AppData\\Local\\cargo-hauler', 'win32');
    const other = daemonSocketPath('D:\\fastdisk\\cargo-hauler', 'win32');
    expect(one).not.toBe(other);
    // Windows paths are case-insensitive: casing drift between clients must
    // not split them onto different pipes.
    expect(daemonSocketPath('C:\\USERS\\Alice\\AppData\\Local\\cargo-hauler', 'win32')).toBe(one);
  });

  it('honors CARGO_HAULER_STATE_DIR in the win32 pipe identity', () => {
    const overridden = resolveDaemonConfig(
      { CARGO_HAULER_STATE_DIR: 'D:\\fastdisk\\cargo-hauler' },
      'win32',
    );
    expect(overridden.stateDir).toBe('D:\\fastdisk\\cargo-hauler');
    expect(overridden.socketPath).toMatch(/^\\\\\.\\pipe\\cargo-hauler-/u);
    expect(overridden.socketPath).not.toBe(resolveDaemonConfig(winEnv, 'win32').socketPath);
  });
});

describe('portable kache index default', () => {
  const noKacheConfig = (): string => {
    throw new Error('ENOENT');
  };

  it('defaults to a kache sibling under the same user cache base', () => {
    expect(defaultKacheIndexPath({}, 'linux', '/home/alice', noKacheConfig)).toBe(
      join('/home/alice', '.cache', 'kache', 'index.db'),
    );
    expect(defaultKacheIndexPath({}, 'linux', '/home/alice', noKacheConfig)).toBe(
      join(userCacheDir({}, 'linux', '/home/alice'), 'kache', 'index.db'),
    );
    // Config resolution and the default helper agree wherever this test
    // machine's kache actually lives — the default is never a hardcode, it
    // is either kache's own configured store or the portable sibling.
    expect(resolveDaemonConfig({}).kacheIndexPath).toBe(defaultKacheIndexPath({}));
  });

  it("prefers the store kache's own config names over the portable guess", () => {
    const read = (path: string): string => {
      expect(path).toBe(join('/home/alice', '.config', 'kache', 'config.toml'));
      return '[cache]\nlocal_store = "/mnt/big/kache"\nexplain_miss = true\n';
    };
    expect(defaultKacheIndexPath({}, 'linux', '/home/alice', read)).toBe(
      join('/mnt/big/kache', 'index.db'),
    );
  });

  it('honors XDG_CONFIG_HOME when locating the kache config', () => {
    const read = (path: string): string => {
      expect(path).toBe(join('/tmp/xdg-config', 'kache', 'config.toml'));
      return 'local_store = "/scratch/kache"\n';
    };
    expect(
      defaultKacheIndexPath({ XDG_CONFIG_HOME: '/tmp/xdg-config' }, 'linux', '/home/alice', read),
    ).toBe(join('/scratch/kache', 'index.db'));
  });

  it('falls back to the portable sibling when the config is unreadable', () => {
    const permissionDenied = (): string => {
      const error = new Error('EACCES: permission denied') as NodeJS.ErrnoException;
      error.code = 'EACCES';
      throw error;
    };
    expect(defaultKacheIndexPath({}, 'linux', '/home/alice', permissionDenied)).toBe(
      join('/home/alice', '.cache', 'kache', 'index.db'),
    );
  });

  it('trusts a configured store path even if nothing exists there yet', () => {
    // Resolution is pure: a config naming a missing/unmounted store still
    // wins, and availability degrades at open time instead of silently
    // rerouting reads to the portable sibling.
    const read = (): string => 'local_store = "/mnt/unmounted/kache"\n';
    expect(defaultKacheIndexPath({}, 'linux', '/home/alice', read)).toBe(
      join('/mnt/unmounted/kache', 'index.db'),
    );
  });

  it('falls back to the portable sibling when the config is malformed or empty', () => {
    expect(
      defaultKacheIndexPath({}, 'linux', '/home/alice', () => 'not toml at all'),
    ).toBe(join('/home/alice', '.cache', 'kache', 'index.db'));
    expect(
      defaultKacheIndexPath({}, 'linux', '/home/alice', () => 'local_store = ""\n'),
    ).toBe(join('/home/alice', '.cache', 'kache', 'index.db'));
  });

  it('prefers CARGO_HAULER_KACHE_INDEX and keeps empty string as disable', () => {
    expect(
      resolveDaemonConfig({ CARGO_HAULER_KACHE_INDEX: '/fast/cache/kache/index.db' })
        .kacheIndexPath,
    ).toBe('/fast/cache/kache/index.db');
    expect(resolveDaemonConfig({ CARGO_HAULER_KACHE_INDEX: '' }).kacheIndexPath).toBe('');
  });

  it('falls back to the legacy kache index while preferring the hauler variable', () => {
    expect(
      resolveDaemonConfig({ CARGO_CONDUCTOR_KACHE_INDEX: '/legacy/kache/index.db' })
        .kacheIndexPath,
    ).toBe('/legacy/kache/index.db');
    expect(
      resolveDaemonConfig({
        CARGO_CONDUCTOR_KACHE_INDEX: '/legacy/kache/index.db',
        CARGO_HAULER_KACHE_INDEX: '',
      }).kacheIndexPath,
    ).toBe('');
  });
});
