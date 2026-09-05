import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Shared state-root resolution used by the daemon config, CLI, hooks, and
 * tests. Defaults must be machine-agnostic: a per-user cache directory
 * following each platform's convention, never a path that only exists on
 * one machine. Operators point elsewhere (a RAM disk, a shared volume)
 * exclusively through CARGO_HAULER_STATE_DIR / CARGO_HAULER_KACHE_INDEX.
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

export const defaultStateDir = (
  env: Readonly<Record<string, string | undefined>> = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string => join(userCacheDir(env, platform, home), 'cargo-hauler');

/**
 * The one state-dir resolution: a non-empty CARGO_HAULER_STATE_DIR wins,
 * otherwise use the per-user default. Daemon config and hook clients both
 * call this, so they cannot drift apart.
 */
export const resolveStateDir = (
  env: Readonly<Record<string, string | undefined>> = process.env,
): string => {
  const current = env.CARGO_HAULER_STATE_DIR;
  if (current !== undefined && current.length > 0) {
    return current;
  }
  return defaultStateDir(env);
};

const namedPipePrefix = '\\\\.\\pipe\\';

export const isNamedPipePath = (path: string): boolean => path.startsWith(namedPipePrefix);

/**
 * The daemon control endpoint for a state dir. On darwin/linux it is a unix
 * domain socket file inside the state dir. Windows IPC cannot bind a
 * filesystem `.sock` path — `net.Server.listen` needs a `\\.\pipe\` name —
 * so win32 derives a named pipe from the state dir (case-folded, since
 * Windows paths are case-insensitive), keeping the endpoint stable per
 * user/state-dir so every client reaches the same daemon.
 */
/**
 * Longest unix socket path the kernel accepts (`sun_path` less the NUL):
 * 103 bytes on macOS and the BSDs, 107 on Linux. A longer path fails to
 * bind, so the daemon never comes up and clients see it as stopped.
 */
const maxSocketPathBytes = (platform: NodeJS.Platform): number =>
  platform === 'linux' ? 107 : 103;

const stateDirDigest = (stateDir: string): string =>
  createHash('sha256').update(stateDir.toLowerCase()).digest('hex').slice(0, 16);

/**
 * The daemon's control endpoint for a state dir: `daemon.sock` inside it on
 * unix, a named pipe on Windows. When the state dir is too deep for
 * `sun_path` (a realpath'd macOS temp root gets there), the socket moves to
 * a short per-user runtime path keyed by a digest of the state dir, so every
 * process resolving that state dir still agrees on one endpoint.
 */
export const daemonSocketPath = (
  stateDir: string,
  platform: NodeJS.Platform = process.platform,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string => {
  if (platform === 'win32') {
    return `${namedPipePrefix}cargo-hauler-${stateDirDigest(stateDir)}`;
  }
  const inState = join(stateDir, 'daemon.sock');
  if (Buffer.byteLength(inState) <= maxSocketPathBytes(platform)) {
    return inState;
  }
  const runtimeDir = env.XDG_RUNTIME_DIR ?? env.TMPDIR ?? tmpdir();
  return join(runtimeDir, `cargo-hauler-${stateDirDigest(stateDir)}.sock`);
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
 * Default kache index when CARGO_HAULER_KACHE_INDEX is unset: the store
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
