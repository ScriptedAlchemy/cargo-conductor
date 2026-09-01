/**
 * Host shell-tool timeouts mined from the tracedecay corpus (Claude hard-kills
 * around 10 minutes; 106 of those kills landed on still-running cargo).
 * Auto-background fires when the priors-based ETA exceeds the cap so the
 * agent keeps working instead of being killed mid-build.
 */
const capsMs: Readonly<Record<string, number>> = {
  claude: 9 * 60_000,
  codex: 10 * 60_000,
  cursor: 14 * 60_000,
};

const defaultCapMs = capsMs.claude;

export const hostShellCapMs = (host: string | undefined): number => {
  if (host === undefined) {
    return defaultCapMs;
  }
  return capsMs[host] ?? defaultCapMs;
};

export const shouldAutoBackground = (estimateMs: number, host: string | undefined): boolean =>
  host !== undefined && estimateMs > hostShellCapMs(host);
