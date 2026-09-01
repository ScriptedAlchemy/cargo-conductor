import { isTransportedEnvironmentVariable } from '../lib/cargo-env.js';

/**
 * The caller-environment subset worth shipping to the daemon: enough for the
 * normalizer's identity digest (RUSTFLAGS and friends), for the spawned
 * cargo to behave like the caller's shell, and for the caller's color
 * request (NO_COLOR and the rest of the `colorEnabled` set) to reach the
 * spawn — without hauling session noise (PATH, PROMPT, …) that would
 * fragment request identity across sessions. The identity digest filters
 * this transport down further, so the color variables never split intents.
 */
export const buildRelevantEnv = (
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> => {
  const relevant: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) {
      continue;
    }
    if (isTransportedEnvironmentVariable(key)) {
      relevant[key] = value;
    }
  }
  return relevant;
};
