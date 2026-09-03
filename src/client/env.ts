import { isTransportedEnvironmentVariable } from '../lib/cargo-env.js';

/**
 * The caller environment shipped to the daemon: everything the caller's
 * shell exported except the hauler-internal `CARGO_HAULER_*` settings. The
 * daemon lays it over its own environment when it spawns cargo, so a
 * brokered request sees the same RUSTFLAGS, build-script knobs, PATH, and
 * color request as a direct `cargo` invocation would. Request identity is
 * digested from the build-relevant subset only, so forwarding session noise
 * (TERM, prompt variables, …) never fragments coalescing.
 */
export const buildTransportedEnv = (
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> => {
  const transported: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) {
      continue;
    }
    if (isTransportedEnvironmentVariable(key)) {
      transported[key] = value;
    }
  }
  return transported;
};
