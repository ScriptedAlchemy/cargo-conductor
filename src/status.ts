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

/**
 * Default kache index when CARGO_CONDUCTOR_KACHE_INDEX is unset: kache's
 * sibling directory under the same per-user cache base. A missing file is
 * fine — kache status degrades to unavailable and priors to defaults.
 */
export const defaultKacheIndexPath = (
  env: Readonly<Record<string, string | undefined>> = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string => join(userCacheDir(env, platform, home), 'kache', 'index.db');
