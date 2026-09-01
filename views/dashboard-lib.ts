/**
 * Pure logic for the dashboard widget, kept DOM-free so unit tests can import
 * it directly (the widget entry touches `document` at module scope).
 */

export const DEMUX_FLAG = '--message-format=json-diagnostic-rendered-ansi';

const asStrings = (value: unknown): readonly string[] | null =>
  Array.isArray(value) && value.every((part) => typeof part === 'string')
    ? (value as readonly string[])
    : null;

export const argvText = (argv: unknown): string => asStrings(argv)?.join(' ') ?? '';

export const escapeHtml = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

const namedPackages = (argv: readonly string[]): Set<string> => {
  const named = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const part = argv[index];
    if (part === '-p' || part === '--package') {
      const name = argv[index + 1];
      if (name !== undefined) {
        named.add(name);
      }
      continue;
    }
    if (part !== undefined && part.startsWith('--package=')) {
      named.add(part.slice('--package='.length));
    }
  }
  return named;
};

export interface RanAs {
  readonly command: string;
  readonly extraPackages: number;
}

/**
 * What the daemon actually spawned, when it materially differs from the
 * request. The injected demux flag alone is noise and yields null; batch
 * composition (folded `-p` packages) surfaces as a "ran as" line with the
 * count of packages beyond the request's own.
 */
export const ranAsFor = (argvValue: unknown, execArgvValue: unknown): RanAs | null => {
  const argv = asStrings(argvValue);
  const execArgv = asStrings(execArgvValue);
  if (argv === null || execArgv === null) {
    return null;
  }
  const cleaned = execArgv.filter((part) => part !== DEMUX_FLAG);
  if (cleaned.length === argv.length && cleaned.every((part, index) => part === argv[index])) {
    return null;
  }
  const requested = namedPackages(argv);
  let extraPackages = 0;
  for (const name of namedPackages(cleaned)) {
    if (!requested.has(name)) {
      extraPackages += 1;
    }
  }
  return { command: cleaned.join(' '), extraPackages };
};

export const relativeTime = (thenMs: number, nowMs: number): string => {
  const seconds = Math.round(Math.max(0, nowMs - thenMs) / 1000);
  if (seconds < 60) {
    return `${seconds}s ago`;
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  return `${Math.round(hours / 24)}d ago`;
};

export const formatMs = (ms: number): string => {
  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  }
  const seconds = ms / 1000;
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds - minutes * 60);
  return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
};

/** `$HOME`-style prefixes become `~`; still-long paths keep the last two segments. */
export const shortenPath = (path: string, maxLength = 38): string => {
  const homed = path.replace(/^\/(?:home|Users)\/[^/]+/u, '~');
  if (homed.length <= maxLength) {
    return homed;
  }
  const segments = homed.split('/').filter((segment) => segment.length > 0);
  if (segments.length <= 2) {
    return homed;
  }
  return `…/${segments.slice(-2).join('/')}`;
};

/** Kick one immediate load, then poll on the given interval. */
export const startPolling = (
  load: () => Promise<void>,
  schedule: (callback: () => void, intervalMs: number) => void,
  intervalMs: number,
): void => {
  void load();
  schedule(() => {
    void load();
  }, intervalMs);
};
