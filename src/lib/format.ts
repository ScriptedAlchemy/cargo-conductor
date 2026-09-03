/**
 * Display formatters shared by Agent Documents (tool/CLI routes) and the
 * dashboard widget. Pure and DOM-free.
 */

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
  // Round to whole seconds before splitting so 17m 59.6s carries to 18m
  // instead of rendering the impossible "17m 60s".
  const wholeSeconds = Math.round(seconds);
  if (wholeSeconds >= 3600) {
    const hours = Math.floor(wholeSeconds / 3600);
    const minutes = Math.floor((wholeSeconds % 3600) / 60);
    return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
  }
  const minutes = Math.floor(wholeSeconds / 60);
  const rest = wholeSeconds - minutes * 60;
  return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
};

/** 1536 → "1.5 KB", 1610612736 → "1.5 GB"; bytes get binary-ish 1024 steps. */
export const formatBytes = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return '—';
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? String(Math.round(value)) : value.toFixed(1)} ${units[unit]}`;
};

export const pathBasename = (path: string): string => {
  const segments = path.split('/').filter((segment) => segment.length > 0);
  const last = segments[segments.length - 1];
  return last === undefined ? path : last;
};

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

/**
 * A command line for display: the program is shown by basename so a request
 * that arrived as `/home/me/.cargo/bin/cargo check` (the PATH shim passes the
 * real binary to avoid re-entering itself) reads as `cargo check`.
 */
export const commandDisplay = (argv: readonly string[]): string => {
  const [program, ...args] = argv;
  return program === undefined ? '' : [pathBasename(program), ...args].join(' ');
};

/**
 * Admission note for the heavy-leader cap, e.g. "1 heavy, cap 1 under low
 * memory". Null unless the cap is currently active or a heavy build is running.
 */
export const heavyCapNote = (
  heavy:
    | { readonly running: number; readonly maxConcurrent: number; readonly capActive: boolean }
    | undefined,
): string | null => {
  if (heavy === undefined || (!heavy.capActive && heavy.running === 0)) {
    return null;
  }
  return heavy.capActive
    ? `${heavy.running} heavy, cap ${heavy.maxConcurrent} under low memory`
    : `${heavy.running} heavy`;
};
