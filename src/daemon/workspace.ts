import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

import { optionParts } from '../lib/argv.js';

const cargoConfigFileNames = ['config.toml', 'config'] as const;
const workspaceRootCacheLimit = 256;

const sectionHeaderPattern = /^\[([^\]]+)\]$/u;
const targetDirPattern = /^target-dir\s*=\s*(?:"([^"]*)"|'([^']*)')$/u;
const packageWorkspacePattern = /^workspace\s*=\s*(?:"([^"]*)"|'([^']*)')$/u;
const workspaceArrayKeyPattern = /^(members|exclude)\s*=\s*(.*)$/u;
const configTargetDirPattern =
  /(?:^|[\s{,])build\.target-dir\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s,#}]+))/u;

export interface LocateWorkspaceRootOptions {
  readonly argv?: readonly string[];
  readonly manifestPath?: string | null;
}

export interface FindConfiguredTargetDirOptions {
  readonly argv?: readonly string[];
  readonly env?: Readonly<Record<string, string | undefined>>;
}

interface ManifestFingerprint {
  readonly mtimeMs: number;
  readonly path: string;
}

interface WorkspaceRootCacheEntry {
  readonly fingerprints: readonly ManifestFingerprint[];
  readonly workspaceRoot: string;
}

interface WorkspaceTable {
  readonly exclude: readonly string[];
  readonly hasWorkspace: boolean;
  readonly members: readonly string[] | undefined;
}

const workspaceRootCache = new Map<string, WorkspaceRootCacheEntry>();

const forEachFlagValue = (
  argv: readonly string[],
  flag: string,
  visit: (value: string) => void,
): void => {
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--') {
      break;
    }
    if (argument === undefined) {
      break;
    }
    const [option, inlineValue] = optionParts(argument);
    if (option !== flag) {
      continue;
    }
    const value =
      inlineValue !== undefined && inlineValue.length > 0 ? inlineValue : argv[index + 1];
    if (value === undefined || value.length === 0 || value === '--') {
      continue;
    }
    if (inlineValue === undefined) {
      index += 1;
    }
    visit(value);
  }
};

const lastFlagValue = (argv: readonly string[] | undefined, flag: string): string | undefined => {
  if (argv === undefined) {
    return undefined;
  }
  let found: string | undefined;
  forEachFlagValue(argv, flag, (value) => {
    found = value;
  });
  return found;
};

const envString = (
  env: Readonly<Record<string, string | undefined>> | undefined,
  name: string,
): string | undefined => {
  if (env === undefined) {
    return undefined;
  }
  const value = env[name];
  return value !== undefined && value.length > 0 ? value : undefined;
};

const resolveMaybeRelative = (base: string, path: string): string =>
  isAbsolute(path) ? path : resolve(base, path);

const sameDirectory = (left: string, right: string): boolean => {
  const resolvedLeft = resolve(left);
  const resolvedRight = resolve(right);
  if (resolvedLeft === resolvedRight) {
    return true;
  }
  try {
    return realpathSync(resolvedLeft) === realpathSync(resolvedRight);
  } catch {
    return false;
  }
};

const posixSegments = (path: string): string[] =>
  path
    .replaceAll('\\', '/')
    .replace(/^\.\//u, '')
    .split('/')
    .filter((segment) => segment.length > 0 && segment !== '.');

const matchSegmentGlob = (pattern: string, value: string): boolean => {
  if (!pattern.includes('*')) {
    return pattern === value;
  }
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/gu, '\\$&').replaceAll('*', '[^/]*');
  return new RegExp(`^${escaped}$`, 'u').test(value);
};

/**
 * Tiny `members`/`exclude` matcher: `*` is one path segment, `**` is zero or
 * more segments. Not implemented: `?`, character classes, `{a,b}` braces,
 * or `**` partial-segment forms (`foo**bar`).
 */
const matchWorkspaceGlob = (pattern: string, relativePath: string): boolean => {
  const patternParts = posixSegments(pattern);
  const pathParts = posixSegments(relativePath);
  const walk = (patternIndex: number, pathIndex: number): boolean => {
    const part = patternParts[patternIndex];
    if (part === undefined) {
      return pathIndex === pathParts.length;
    }
    if (part === '**') {
      if (patternIndex === patternParts.length - 1) {
        return true;
      }
      for (let skip = 0; skip <= pathParts.length - pathIndex; skip += 1) {
        if (walk(patternIndex + 1, pathIndex + skip)) {
          return true;
        }
      }
      return false;
    }
    const value = pathParts[pathIndex];
    if (value === undefined || !matchSegmentGlob(part, value)) {
      return false;
    }
    return walk(patternIndex + 1, pathIndex + 1);
  };
  return walk(0, 0);
};

const parseTomlStringArray = (raw: string): string[] | undefined => {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('[')) {
    return undefined;
  }
  const values: string[] = [];
  let index = 1;
  let inString = false;
  let quote: '"' | "'" | undefined;
  let current = '';
  while (index < trimmed.length) {
    const character = trimmed[index];
    if (character === undefined) {
      break;
    }
    if (!inString) {
      if (character === '#') {
        const newline = trimmed.indexOf('\n', index);
        index = newline === -1 ? trimmed.length : newline + 1;
        continue;
      }
      if (character === '"' || character === "'") {
        inString = true;
        quote = character;
        current = '';
        index += 1;
        continue;
      }
      if (character === ']') {
        return values;
      }
      if (character === ',' || /\s/u.test(character)) {
        index += 1;
        continue;
      }
      return undefined;
    }
    if (character === '\\' && quote === '"') {
      current += trimmed[index + 1] ?? '';
      index += 2;
      continue;
    }
    if (character === quote) {
      values.push(current);
      inString = false;
      quote = undefined;
      index += 1;
      continue;
    }
    current += character;
    index += 1;
  }
  return undefined;
};

const isWorkspaceSection = (section: string): boolean =>
  section === 'workspace' || section.startsWith('workspace.');

const parseWorkspaceTable = (contents: string): WorkspaceTable => {
  let section = '';
  let hasWorkspace = false;
  let members: string[] | undefined;
  const exclude: string[] = [];
  let pendingKey: 'exclude' | 'members' | undefined;
  let pendingBuffer = '';

  const assignArray = (key: 'exclude' | 'members', values: readonly string[]): void => {
    switch (key) {
      case 'exclude':
        exclude.push(...values);
        return;
      case 'members':
        members = [...values];
        return;
      default: {
        const exhaustive: never = key;
        throw new Error(`unhandled workspace array key: ${exhaustive}`);
      }
    }
  };

  const finishPending = (chunk: string): boolean => {
    if (pendingKey === undefined) {
      return true;
    }
    pendingBuffer = pendingBuffer.length === 0 ? chunk : `${pendingBuffer}\n${chunk}`;
    const parsed = parseTomlStringArray(pendingBuffer);
    if (parsed === undefined) {
      return false;
    }
    assignArray(pendingKey, parsed);
    pendingKey = undefined;
    pendingBuffer = '';
    return true;
  };

  for (const rawLine of contents.split(/\r?\n/u)) {
    if (pendingKey !== undefined) {
      if (!finishPending(rawLine)) {
        continue;
      }
    }
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) {
      continue;
    }
    const sectionHeader = sectionHeaderPattern.exec(line);
    if (sectionHeader !== null) {
      section = sectionHeader[1].trim();
      if (isWorkspaceSection(section)) {
        hasWorkspace = true;
      }
      continue;
    }
    if (section !== 'workspace') {
      continue;
    }
    const arrayKey = workspaceArrayKeyPattern.exec(line);
    if (arrayKey === null) {
      continue;
    }
    const key = arrayKey[1] === 'exclude' ? 'exclude' : 'members';
    const parsed = parseTomlStringArray(arrayKey[2]);
    if (parsed !== undefined) {
      assignArray(key, parsed);
      continue;
    }
    if (arrayKey[2].trim().startsWith('[')) {
      pendingKey = key;
      pendingBuffer = arrayKey[2];
    }
  }
  if (pendingKey !== undefined) {
    finishPending('');
  }
  return { exclude, hasWorkspace, members };
};

const parsePackageWorkspace = (contents: string): string | undefined => {
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
    if (section !== 'package') {
      continue;
    }
    const workspace = packageWorkspacePattern.exec(line);
    if (workspace !== null) {
      return workspace[1] ?? workspace[2];
    }
  }
  return undefined;
};

const readManifest = (directory: string): string | undefined => {
  const manifestPath = join(directory, 'Cargo.toml');
  try {
    return readFileSync(manifestPath, 'utf8');
  } catch {
    return undefined;
  }
};

const isWorkspaceMember = (
  workspaceDir: string,
  workspaceContents: string,
  packageDir: string,
  packageContents: string,
): boolean => {
  if (sameDirectory(workspaceDir, packageDir)) {
    return true;
  }
  const table = parseWorkspaceTable(workspaceContents);
  const relativePackage = relative(resolve(workspaceDir), resolve(packageDir));
  const underWorkspace = relativePackage.length > 0 && !relativePackage.startsWith('..') && !isAbsolute(relativePackage);
  if (underWorkspace && table.exclude.some((pattern) => matchWorkspaceGlob(pattern, relativePackage))) {
    return false;
  }
  if (underWorkspace && table.members !== undefined) {
    if (table.members.some((pattern) => matchWorkspaceGlob(pattern, relativePackage))) {
      return true;
    }
  }
  const packageWorkspace = parsePackageWorkspace(packageContents);
  if (packageWorkspace === undefined || packageWorkspace.length === 0) {
    return false;
  }
  return sameDirectory(resolveMaybeRelative(packageDir, packageWorkspace), workspaceDir);
};

/**
 * Nearest-manifest workspace identity. Does not shell out to cargo: a
 * `cargo locate-project` per submit is too slow for the hot path.
 *
 * Walk up from the anchor (cwd, or `--manifest-path`'s directory) to the
 * nearest `Cargo.toml`, then to the first ancestor whose manifest has a
 * `[workspace]` table. That ancestor wins only when the nearest package is
 * the workspace root itself, is listed by `workspace.members` (glob-aware),
 * or names that root via `[package].workspace` — and is not `exclude`d.
 * Otherwise the nearest package directory is the root (standalone).
 *
 * Documented divergences from cargo: no `?` / `{a,b}` / character-class
 * globs; no inline `workspace = { ... }` tables; no dotted `workspace.members`
 * keys outside a `[workspace]` section; the first `[workspace]` ancestor is
 * decisive (we do not skip it to honor `package.workspace` further up, or a
 * non-ancestor workspace path); `[patch]`, path-deps outside the tree, and
 * config `paths` overrides are ignored. Pathological layouts may still
 * diverge from `cargo locate-project`.
 */
const computeWorkspaceRoot = (anchor: string): string => {
  const start = resolve(anchor);
  let current = start;
  let nearestDir: string | undefined;
  let nearestContents: string | undefined;
  for (;;) {
    const contents = readManifest(current);
    if (contents !== undefined) {
      nearestDir = current;
      nearestContents = contents;
      break;
    }
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  if (nearestDir === undefined || nearestContents === undefined) {
    return start;
  }
  if (parseWorkspaceTable(nearestContents).hasWorkspace) {
    return nearestDir;
  }
  current = dirname(nearestDir);
  for (;;) {
    const contents = readManifest(current);
    if (contents !== undefined && parseWorkspaceTable(contents).hasWorkspace) {
      return isWorkspaceMember(current, contents, nearestDir, nearestContents)
        ? current
        : nearestDir;
    }
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return nearestDir;
};

const fingerprintAncestorManifests = (anchor: string): ManifestFingerprint[] => {
  const fingerprints: ManifestFingerprint[] = [];
  let current = resolve(anchor);
  for (;;) {
    const manifestPath = join(current, 'Cargo.toml');
    try {
      fingerprints.push({ mtimeMs: statSync(manifestPath).mtimeMs, path: manifestPath });
    } catch {
      // Absent manifests are part of the walk; a later create invalidates.
    }
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return fingerprints;
};

const fingerprintsMatch = (
  left: readonly ManifestFingerprint[],
  right: readonly ManifestFingerprint[],
): boolean => {
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    const leftEntry = left[index];
    const rightEntry = right[index];
    if (
      leftEntry === undefined ||
      rightEntry === undefined ||
      leftEntry.path !== rightEntry.path ||
      leftEntry.mtimeMs !== rightEntry.mtimeMs
    ) {
      return false;
    }
  }
  return true;
};

const rememberWorkspaceRoot = (anchor: string, entry: WorkspaceRootCacheEntry): void => {
  if (workspaceRootCache.size >= workspaceRootCacheLimit && !workspaceRootCache.has(anchor)) {
    const oldest = workspaceRootCache.keys().next().value;
    if (oldest !== undefined) {
      workspaceRootCache.delete(oldest);
    }
  }
  workspaceRootCache.set(anchor, entry);
};

const resolveAnchorDirectory = (cwd: string, options?: LocateWorkspaceRootOptions): string => {
  const manifestPath =
    options?.manifestPath !== undefined &&
    options.manifestPath !== null &&
    options.manifestPath.length > 0
      ? options.manifestPath
      : lastFlagValue(options?.argv, '--manifest-path');
  if (manifestPath === undefined) {
    return resolve(cwd);
  }
  return dirname(resolveMaybeRelative(cwd, manifestPath));
};

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
    return resolveMaybeRelative(directory, targetDir);
  }
  return undefined;
};

const extractConfigTargetDir = (argv: readonly string[] | undefined): string | undefined => {
  if (argv === undefined) {
    return undefined;
  }
  let found: string | undefined;
  forEachFlagValue(argv, '--config', (value) => {
    const matched = configTargetDirPattern.exec(value);
    if (matched !== null) {
      found = matched[1] ?? matched[2] ?? matched[3];
    }
  });
  return found;
};

const readConfiguredTargetDirFiles = (cwd: string, workspaceRoot: string): string | undefined => {
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

export const locateWorkspaceRoot = (
  cwd: string,
  options?: LocateWorkspaceRootOptions,
): string => {
  const anchor = resolveAnchorDirectory(cwd, options);
  const fingerprints = fingerprintAncestorManifests(anchor);
  const cached = workspaceRootCache.get(anchor);
  if (cached !== undefined && fingerprintsMatch(cached.fingerprints, fingerprints)) {
    return cached.workspaceRoot;
  }
  const workspaceRoot = computeWorkspaceRoot(anchor);
  rememberWorkspaceRoot(anchor, { fingerprints, workspaceRoot });
  return workspaceRoot;
};

export const findConfiguredTargetDir = (
  cwd: string,
  workspaceRoot: string,
  options?: FindConfiguredTargetDirOptions,
): string | undefined => {
  const fromTargetDir = envString(options?.env, 'CARGO_TARGET_DIR');
  if (fromTargetDir !== undefined) {
    return resolveMaybeRelative(cwd, fromTargetDir);
  }
  const fromBuildTargetDir = envString(options?.env, 'CARGO_BUILD_TARGET_DIR');
  if (fromBuildTargetDir !== undefined) {
    return resolveMaybeRelative(cwd, fromBuildTargetDir);
  }
  const fromConfigFlag = extractConfigTargetDir(options?.argv);
  if (fromConfigFlag !== undefined) {
    return resolveMaybeRelative(cwd, fromConfigFlag);
  }
  return readConfiguredTargetDirFiles(cwd, workspaceRoot);
};
