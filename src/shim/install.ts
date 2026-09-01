import { chmodSync, existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join, resolve } from 'node:path';

export interface RenderShimOptions {
  readonly conductorArgv: readonly string[];
  readonly realCargo: string;
}

export interface InstallShimOptions extends RenderShimOptions {
  readonly destDir?: string;
  readonly force?: boolean;
}

export interface InstallShimResult {
  readonly path: string;
}

const shellQuote = (value: string): string => {
  if (value.length === 0) {
    return "''";
  }
  if (/^[A-Za-z0-9_./-]+$/u.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", `'\\''`)}'`;
};

export const renderCargoShim = (options: RenderShimOptions): string => {
  const conductor = options.conductorArgv.map(shellQuote).join(' ');
  const cargo = shellQuote(options.realCargo);
  // --host shim: unlike hook rewrites, the shim has no agent identity, but the
  // ledger should still say where a request entered. CARGO_CONDUCTOR_INSIDE
  // marks cargo spawned by the daemon itself; forwarding it would submit the
  // broker's own work back to the broker.
  return `#!/bin/sh
# cargo-conductor PATH shim — forwards cargo to the broker.
# Installed by \`conductor install-shim\`. Hooks cannot see cargo inside scripts.
if [ -n "\${CARGO_CONDUCTOR_INSIDE:-}" ]; then
  exec ${cargo} "$@"
fi
exec ${conductor} exec --host shim -- ${cargo} "$@"
`;
};

export const defaultShimDir = (): string => join(homedir(), '.local', 'bin');

const canonical = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
};

/**
 * Resolves the real cargo to an ABSOLUTE path, skipping anything inside the
 * shim's own directory. Embedding a bare `cargo` would let the broker daemon
 * resolve the shim itself through PATH — the shim would call the broker
 * which spawns the shim: a self-attachment deadlock.
 */
export const resolveRealCargo = (
  realCargo: string,
  destDir: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string => {
  const canonicalDest = canonical(destDir);
  const insideDest = (path: string): boolean => {
    const resolved = canonical(path);
    return resolved === join(canonicalDest, 'cargo') || resolved.startsWith(`${canonicalDest}/`);
  };
  if (isAbsolute(realCargo)) {
    // An explicit absolute path is the operator's call; only self-reference
    // is refused.
    if (insideDest(realCargo)) {
      throw new Error(
        `--real-cargo ${realCargo} points at the shim itself; pass the real cargo binary`,
      );
    }
    return realCargo;
  }
  for (const entry of (env.PATH ?? '').split(delimiter)) {
    if (entry.length === 0) {
      continue;
    }
    const candidate = join(entry, realCargo);
    if (!existsSync(candidate) || insideDest(candidate)) {
      continue;
    }
    return canonical(candidate);
  }
  throw new Error(
    `could not resolve a real ${realCargo} outside ${destDir}; pass --real-cargo /path/to/cargo`,
  );
};

export const installCargoShim = (options: InstallShimOptions): InstallShimResult => {
  const destDir = options.destDir ?? defaultShimDir();
  mkdirSync(destDir, { recursive: true });
  const path = join(destDir, 'cargo');
  if (existsSync(path) && options.force !== true) {
    throw new Error(`cargo already exists at ${path}; pass --force to replace it`);
  }
  const realCargo = resolveRealCargo(options.realCargo, destDir);
  writeFileSync(path, renderCargoShim({ ...options, realCargo }));
  chmodSync(path, 0o755);
  return { path };
};
