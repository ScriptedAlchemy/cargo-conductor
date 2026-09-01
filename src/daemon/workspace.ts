import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

const cargoConfigFileNames = ['config.toml', 'config'] as const;

const sectionHeaderPattern = /^\[([^\]]+)\]$/u;
const targetDirPattern = /^target-dir\s*=\s*(?:"([^"]*)"|'([^']*)')$/u;

/** Deliberately not a TOML parser: inline tables and dotted `build.target-dir` keys are out of scope for v1. */
const parseBuildTargetDir = (contents: string): string | undefined => {
  let section = '';
  for (const rawLine of contents.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) {
      continue;
    }
    const sectionHeader = sectionHeaderPattern.exec(line);
    if (sectionHeader !== null) {
      section = sectionHeader[1].trim();
      continue;
    }
    if (section !== 'build') {
      continue;
    }
    const targetDir = targetDirPattern.exec(line);
    if (targetDir !== null) {
      return targetDir[1] ?? targetDir[2];
    }
  }
  return undefined;
};

/** Cargo resolves relative config paths against the parent of the `.cargo` directory. */
const readTargetDirAt = (directory: string): string | undefined => {
  for (const fileName of cargoConfigFileNames) {
    const configPath = join(directory, '.cargo', fileName);
    if (!existsSync(configPath)) {
      continue;
    }
    const targetDir = parseBuildTargetDir(readFileSync(configPath, 'utf8'));
    if (targetDir === undefined) {
      continue;
    }
    return isAbsolute(targetDir) ? targetDir : resolve(directory, targetDir);
  }
  return undefined;
};

/** The topmost `Cargo.toml` wins because a cargo workspace manifest sits above its members. */
export const locateWorkspaceRoot = (cwd: string): string => {
  const start = resolve(cwd);
  let current = start;
  let topmost: string | undefined;
  for (;;) {
    if (existsSync(join(current, 'Cargo.toml'))) {
      topmost = current;
    }
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return topmost ?? start;
};

export const findConfiguredTargetDir = (cwd: string, workspaceRoot: string): string | undefined => {
  const stopAt = resolve(workspaceRoot);
  let current = resolve(cwd);
  for (;;) {
    const targetDir = readTargetDirAt(current);
    if (targetDir !== undefined) {
      return targetDir;
    }
    const parent = dirname(current);
    if (current === stopAt || parent === current) {
      return undefined;
    }
    current = parent;
  }
};
