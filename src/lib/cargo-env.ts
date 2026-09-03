const exactEnvironmentNames = new Set([
  'AR',
  'CC',
  'CFLAGS',
  'CXX',
  'CXXFLAGS',
  'LDFLAGS',
  'PKG_CONFIG_PATH',
]);

const haulerPrefix = 'CARGO_HAULER_';
const legacyConductorPrefix = 'CARGO_CONDUCTOR_';

const targetToolPattern =
  /^(?:AR|CC|CFLAGS|CXX|CXXFLAGS|LDFLAGS)_[A-Za-z0-9_-]+$/u;

/**
 * Daemon and hook settings. They configure the broker itself and never ride
 * along with a request: a caller's `CARGO_HAULER_STATE_DIR` must not retarget
 * the daemon-spawned cargo, and none of them affect what cargo builds.
 */
export const isHaulerInternalEnvironmentVariable = (name: string): boolean =>
  name.startsWith(haulerPrefix) || name.startsWith(legacyConductorPrefix);

/**
 * The variables that participate in request identity (coalescing). Two
 * requests that differ only outside this set share a leader, so the set is
 * deliberately the cargo/rustc/linker knobs that change build output for
 * every crate, not the open-ended space of variables a `build.rs` or
 * `env!()` may read.
 */
export const isRelevantCargoEnvironmentVariable = (name: string): boolean =>
  !isHaulerInternalEnvironmentVariable(name) &&
  (exactEnvironmentNames.has(name) ||
    name.startsWith('CARGO_') ||
    name.startsWith('RUST') ||
    targetToolPattern.test(name));

/**
 * The variables the client ships to the daemon for the spawned cargo. The
 * caller's whole environment travels, minus the hauler-internal settings, so
 * a brokered `FOO=bar cargo build` behaves like the direct invocation: build
 * scripts, `env!()`, `cargo run` and `cargo test` processes see the same
 * variables the caller exported. Identity is decided separately by
 * {@link isRelevantCargoEnvironmentVariable}; session noise such as TERM,
 * NO_COLOR, or a prompt variable is forwarded but never splits an intent.
 */
export const isTransportedEnvironmentVariable = (name: string): boolean =>
  !isHaulerInternalEnvironmentVariable(name);
