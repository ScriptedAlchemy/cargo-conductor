import { isRelevantCargoEnvironmentVariable } from '../lib/cargo-env.js';

/**
 * The caller-environment subset worth shipping to the daemon: enough for the
 * normalizer's identity digest (RUSTFLAGS and friends) and for the spawned
 * cargo to behave like the caller's shell, without hauling session noise
 * (PATH, PROMPT, …) that would fragment request identity across sessions.
 */
export const buildRelevantEnv = (
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> => {
  const relevant: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) {
      continue;
    }
    if (isRelevantCargoEnvironmentVariable(key)) {
      relevant[key] = value;
    }
  }
  return relevant;
};
