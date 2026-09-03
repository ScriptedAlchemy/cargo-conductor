import { isTransportedEnvironmentVariable } from '../lib/cargo-env.js';

const jobserverFlagNames = new Set(['CARGO_MAKEFLAGS', 'MAKEFLAGS', 'MFLAGS']);

/**
 * A GNU make jobserver handed down through file descriptors
 * (`--jobserver-auth=R,W`, or the pre-4.4 `--jobserver-fds=R,W`) names
 * descriptors open in the caller, not in the daemon. Only the FIFO form
 * (`--jobserver-auth=fifo:PATH`) is a path another process can open.
 */
const carriesDescriptorJobserver = (value: string): boolean =>
  /--jobserver-fds=/u.test(value) || /--jobserver-auth=(?!fifo:)/u.test(value);

/**
 * The caller environment shipped to the daemon: everything the caller's
 * shell exported except the hauler-internal `CARGO_HAULER_*` settings. The
 * daemon lays it over its own environment when it spawns cargo, so a
 * brokered request sees the same RUSTFLAGS, build-script knobs, PATH, and
 * color request as a direct `cargo` invocation would. Request identity is
 * digested from the build-relevant subset only, so forwarding session noise
 * (TERM, prompt variables, …) never fragments coalescing.
 *
 * One value-based exception: make jobserver flags that refer to the caller's
 * file descriptors are dropped, because cargo would still honour them in the
 * daemon (where the descriptors do not exist) and skip the daemon's own
 * shared FIFO jobserver for the run.
 */
export const buildTransportedEnv = (
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> => {
  const transported: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) {
      continue;
    }
    if (jobserverFlagNames.has(key) && carriesDescriptorJobserver(value)) {
      continue;
    }
    if (isTransportedEnvironmentVariable(key)) {
      transported[key] = value;
    }
  }
  return transported;
};
