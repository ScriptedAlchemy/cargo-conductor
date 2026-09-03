import { parseCargoArgv } from '../daemon/intent-normalizer.js';

/**
 * Cargo subcommands that never compile: metadata reads, registry and lockfile
 * operations, manifest edits, and rustfmt. Brokering them buys nothing — they
 * hold a lane slot, receive a generic multi-minute cost estimate, and pollute
 * the job-outcome metrics (observed: `cargo hauler --help` ticketed with a
 * ~120s ETA and recorded as a failed job; `cargo fmt --all` queued for
 * minutes behind five compiles). Compile-shaped verbs (build/check/test/
 * clippy/run/doc/install/publish/…) and unknown third-party subcommands stay
 * brokered: an unknown subcommand can compile arbitrarily much, so only the
 * closed known-query set bypasses.
 */
const querySubcommands = new Set([
  'add',
  'fetch',
  'fmt',
  'generate-lockfile',
  'help',
  'info',
  'init',
  'locate-project',
  'login',
  'logout',
  'metadata',
  'new',
  'owner',
  'pkgid',
  'read-manifest',
  'remove',
  'report',
  'search',
  'tree',
  'uninstall',
  'update',
  'vendor',
  'verify-project',
  'version',
  'yank',
]);

/**
 * Flags that make cargo print text and exit without compiling, regardless of
 * the subcommand. Scanning stops at `--`: trailing arguments belong to the
 * spawned program (`cargo run -- --help` runs a build).
 */
const queryFlags = new Set(['--help', '-h', '--version', '-V', '--list']);

/**
 * Reason this invocation resolves locally without a broker ticket, or `null`
 * when it is real work for the daemon.
 */
export const localQueryReason = (argv: readonly string[]): string | null => {
  for (const argument of argv) {
    if (argument === '--') {
      break;
    }
    if (queryFlags.has(argument)) {
      return `${argument} is a local query`;
    }
  }
  let subcommand: string;
  try {
    subcommand = parseCargoArgv(argv).subcommand;
  } catch {
    // No subcommand (bare `cargo` prints usage and exits) or an argv shape
    // cargo itself will refuse immediately; either way the daemon cannot
    // improve on running it in place.
    return 'cargo resolves this locally';
  }
  return querySubcommands.has(subcommand) ? `${subcommand} is a local query` : null;
};
