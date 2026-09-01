import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * The real cargo binary for daemon-spawned work. Never resolve bare `cargo`
 * through PATH here: once the conductor shim is installed it sits first on
 * PATH, and a daemon that launches the shim submits work back to itself.
 *
 * `CARGO_CONDUCTOR_CARGO_BIN` (read from the per-job env when present) is the
 * explicit override; the test harness uses it to route jobs at its fake cargo.
 */
export const realCargoBin = (
  env: Readonly<Record<string, string | undefined>> = process.env,
): string => {
  const override = env.CARGO_CONDUCTOR_CARGO_BIN;
  if (override !== undefined && override.length > 0) {
    return override;
  }
  const cargoHome = env.CARGO_HOME ?? join(homedir(), '.cargo');
  const candidate = join(cargoHome, 'bin', 'cargo');
  return existsSync(candidate) ? candidate : 'cargo';
};
