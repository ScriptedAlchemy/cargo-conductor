import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Shared state-root resolution used by the daemon config, CLI, hooks, and
 * tests. Defaults must be machine-agnostic: a per-user cache directory
 * following each platform's convention, never a path that only exists on
 * one machine. Operators point elsewhere (a RAM disk, a shared volume)
 * exclusively through CARGO_CONDUCTOR_STATE_DIR / CARGO_CONDUCTOR_KACHE_INDEX.
 */

/**
 * Per-user cache base: `$XDG_CACHE_HOME` when set, else `~/Library/Caches`
 * on macOS, `%LOCALAPPDATA%` on Windows, `~/.cache` everywhere else.
 */
export const userCacheDir = (
  env: Readonly<Record<string, string | undefined>> = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string => {
  const xdgCacheHome = env.XDG_CACHE_HOME;
  if (xdgCacheHome !== undefined && xdgCacheHome.length > 0) {
    return xdgCacheHome;
  }
  if (platform === 'darwin') {
    return join(home, 'Library', 'Caches');
  }
  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA;
    return localAppData !== undefined && localAppData.length > 0
      ? localAppData
      : join(home, 'AppData', 'Local');
  }
  return join(home, '.cache');
};

/** Default daemon state root when CARGO_CONDUCTOR_STATE_DIR is unset. */
export const defaultStateDir = (
  env: Readonly<Record<string, string | undefined>> = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string => join(userCacheDir(env, platform, home), 'cargo-conductor');

/**
 * The one state-dir resolution: CARGO_CONDUCTOR_STATE_DIR wins, otherwise
 * the portable per-user default. Daemon config and hook clients both call
 * this, so they cannot drift apart.
 */
export const resolveStateDir = (
  env: Readonly<Record<string, string | undefined>> = process.env,
): string => {
  const override = env.CARGO_CONDUCTOR_STATE_DIR;
  return override !== undefined && override.length > 0
    ? override
    : defaultStateDir(env);
};

const namedPipePrefix = '\\\\.\\pipe\\';

/** Whether a daemon endpoint is a Windows named pipe rather than a filesystem path. */
export const isNamedPipePath = (path: string): boolean => path.startsWith(namedPipePrefix);

/**
 * The daemon control endpoint for a state dir. On darwin/linux it is a unix
 * domain socket file inside the state dir. Windows IPC cannot bind a
 * filesystem `.sock` path — `net.Server.listen` needs a `\\.\pipe\` name —
 * so win32 derives a named pipe from the state dir (case-folded, since
 * Windows paths are case-insensitive), keeping the endpoint stable per
 * user/state-dir so every client reaches the same daemon.
 */
export const daemonSocketPath = (
  stateDir: string,
  platform: NodeJS.Platform = process.platform,
): string => {
  if (platform !== 'win32') {
    return join(stateDir, 'daemon.sock');
  }
  const digest = createHash('sha256').update(stateDir.toLowerCase()).digest('hex').slice(0, 16);
  return `${namedPipePrefix}cargo-conductor-${digest}`;
};

/**
 * kache's configured store root, read from its own config
 * (`$XDG_CONFIG_HOME/kache/config.toml`, else `~/.config/kache/config.toml`):
 * the `local_store` key under `[cache]`. Guessing a sibling cache directory
 * would silently lose kache costs/status on any machine whose store lives
 * elsewhere (a dedicated fast disk is common); kache itself is the authority
 * for where its index is. The tolerant line match is deliberate — the value
 * is one quoted path and a TOML parser dependency buys nothing here.
 */
const kacheConfiguredStore = (
  env: Readonly<Record<string, string | undefined>>,
  home: string,
  read: (path: string) => string,
): string | null => {
  const configHome =
    env.XDG_CONFIG_HOME !== undefined && env.XDG_CONFIG_HOME.length > 0
      ? env.XDG_CONFIG_HOME
      : join(home, '.config');
  let content: string;
  try {
    content = read(join(configHome, 'kache', 'config.toml'));
  } catch {
    return null;
  }
  const match = /^\s*local_store\s*=\s*"([^"]+)"/mu.exec(content);
  return match === null || match[1].length === 0 ? null : match[1];
};

/**
 * Default kache index when CARGO_CONDUCTOR_KACHE_INDEX is unset: the store
 * kache's own config names, else kache's sibling directory under the same
 * per-user cache base. A missing file is fine — kache status degrades to
 * unavailable and priors to defaults.
 */
export const defaultKacheIndexPath = (
  env: Readonly<Record<string, string | undefined>> = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
  read: (path: string) => string = (path) => readFileSync(path, 'utf8'),
): string => {
  const configured = kacheConfiguredStore(env, home, read);
  return configured !== null
    ? join(configured, 'index.db')
    : join(userCacheDir(env, platform, home), 'kache', 'index.db');
};
