/**
 * The caller-environment subset worth shipping to the daemon: enough for the
 * normalizer's identity digest (RUSTFLAGS and friends) and for the spawned
 * cargo to behave like the caller's shell, without hauling session noise
 * (PATH, PROMPT, …) that would fragment request identity across sessions.
 */
const exactKeys = new Set(['AR', 'CC', 'CXX', 'PKG_CONFIG_PATH']);
const prefixes = ['CARGO_', 'RUST'];
const internalPrefix = 'CARGO_CONDUCTOR_';

export const buildRelevantEnv = (
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> => {
  const relevant: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || key.startsWith(internalPrefix)) {
      continue;
    }
    if (exactKeys.has(key) || prefixes.some((prefix) => key.startsWith(prefix))) {
      relevant[key] = value;
    }
  }
  return relevant;
};
