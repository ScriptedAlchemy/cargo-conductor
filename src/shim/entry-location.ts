import { existsSync, realpathSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';

export type HaulerEntryLocation =
  | { readonly kind: 'host-plugin'; readonly path: string }
  | { readonly kind: 'npm-bin'; readonly path: string }
  | { readonly kind: 'other'; readonly path: string | null };

const canonical = (path: string): string => {
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
};

const pluginCachePath =
  /\/(?:\.cursor\/plugins\/|\.claude\/plugins\/cache\/|\.codex\/plugins\/cache\/|artifact\/[^/]+\/)/u;

/**
 * Classifies the currently running `hauler` entry. Host packs emit this file
 * as `scripts/hauler.mjs`; the npm executable is `dist/bin/hauler.js`.
 */
export const haulerEntryLocation = (
  entryPath: string | undefined = process.argv[1],
): HaulerEntryLocation => {
  if (entryPath === undefined || entryPath.length === 0) {
    return { kind: 'other', path: null };
  }
  const path = canonical(entryPath);
  const normalized = path.replaceAll('\\', '/');
  const isHaulerScript = normalized.endsWith('/scripts/hauler.mjs');
  const hasHostPackSibling =
    isHaulerScript && existsSync(join(dirname(path), '..', 'bin', 'cargo-hauler.mjs'));
  if (isHaulerScript && (hasHostPackSibling || pluginCachePath.test(normalized))) {
    return { kind: 'host-plugin', path };
  }
  if (normalized.endsWith('/dist/bin/hauler.js')) {
    return { kind: 'npm-bin', path };
  }
  return { kind: 'other', path };
};

/**
 * Absolute node + global `hauler` script for a PATH shim. The npm bin can
 * embed itself; every other accepted caller resolves and canonicalizes the
 * `hauler` command found on PATH.
 */
export const globalHaulerArgv = (
  location: HaulerEntryLocation,
  env: Readonly<Record<string, string | undefined>> = process.env,
): readonly string[] => {
  if (location.kind === 'npm-bin') {
    return [process.execPath, location.path];
  }
  for (const entry of (env.PATH ?? '').split(delimiter)) {
    if (entry.length === 0) {
      continue;
    }
    const candidate = join(entry, 'hauler');
    if (existsSync(candidate)) {
      return [process.execPath, realpathSync(candidate)];
    }
  }
  throw new Error(
    'could not resolve `hauler` on PATH; install it with `npm i -g cargo-hauler`',
  );
};
