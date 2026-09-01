import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

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
  return `#!/bin/sh
# cargo-conductor PATH shim — forwards cargo to the broker.
# Installed by \`conductor install-shim\`. Hooks cannot see cargo inside scripts.
exec ${conductor} exec -- ${cargo} "$@"
`;
};

export const defaultShimDir = (): string => join(homedir(), '.local', 'bin');

export const installCargoShim = (options: InstallShimOptions): InstallShimResult => {
  const destDir = options.destDir ?? defaultShimDir();
  mkdirSync(destDir, { recursive: true });
  const path = join(destDir, 'cargo');
  if (existsSync(path) && options.force !== true) {
    throw new Error(`cargo already exists at ${path}; pass --force to replace it`);
  }
  writeFileSync(path, renderCargoShim(options));
  chmodSync(path, 0o755);
  return { path };
};
