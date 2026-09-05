import { existsSync, realpathSync, statSync } from 'node:fs';
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
 * Absolute node + global `hauler` script for a PATH shim: the canonical path
 * of the `hauler` command found on PATH, whatever entry is running. Only when
 * PATH has none does an npm bin embed itself (a checkout's `dist/bin/hauler.js`
 * is also an npm-shaped bin, so it never shadows an installed global).
 */
export const globalHaulerArgv = (
  location: HaulerEntryLocation,
  env: Readonly<Record<string, string | undefined>> = process.env,
): readonly string[] => {
  for (const entry of (env.PATH ?? '').split(delimiter)) {
    if (entry.length === 0) {
      continue;
    }
    const resolved = pathHaulerScript(join(entry, 'hauler'));
    if (resolved !== null) {
      return [process.execPath, resolved];
    }
  }
  if (location.kind === 'npm-bin') {
    return [process.execPath, location.path];
  }
  throw new Error(
    'could not resolve `hauler` on PATH; install it with `npm i -g cargo-hauler`',
  );
};

const nodeScript = /\.[cm]?js$/u;

/**
 * The canonical script behind one PATH candidate, or `null` when it is not a
 * regular JavaScript file the shim can hand to `node` (a directory, a dangling
 * link, a version-manager shim that resolves to a native binary), or resolves
 * into a host plugin copy — which is exactly what the shim must not embed.
 */
const pathHaulerScript = (candidate: string): string | null => {
  let resolved: string;
  try {
    resolved = realpathSync(candidate);
    if (!statSync(resolved).isFile() || !nodeScript.test(resolved)) {
      return null;
    }
  } catch {
    return null;
  }
  return haulerEntryLocation(resolved).kind === 'host-plugin' ? null : resolved;
};
