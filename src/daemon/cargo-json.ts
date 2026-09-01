/**
 * Minimal parser for cargo's `--message-format=json-diagnostic-rendered-ansi`
 * stdout stream: one JSON document per line. Only the fields the broker
 * routes on are extracted; unknown reasons and non-JSON lines are passed
 * through as opaque output.
 */

export type CargoJsonEvent =
  | {
      readonly kind: 'artifact';
      readonly packageName: string | null;
      readonly targetKinds: readonly string[];
      readonly fresh: boolean;
    }
  | {
      readonly kind: 'message';
      readonly packageName: string | null;
      readonly targetKinds: readonly string[];
      readonly level: string | null;
      readonly rendered: string | null;
    }
  | {
      readonly kind: 'build-finished';
      readonly success: boolean;
    }
  | {
      readonly kind: 'other';
    };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Extracts the package name from either package-id format:
 * - spec URLs (cargo >= 1.77): `path+file:///repo#name@0.1.0`,
 *   `registry+https://...#name@1.2.3`, or `path+file:///repo/name#0.1.0`
 *   (name taken from the last path segment when the fragment is only a version).
 * - legacy triples: `name 0.1.0 (path+file:///repo)`.
 */
export const packageNameFromId = (packageId: string): string | null => {
  const hashIndex = packageId.indexOf('#');
  if (hashIndex !== -1) {
    const fragment = packageId.slice(hashIndex + 1);
    const atIndex = fragment.lastIndexOf('@');
    const name = atIndex === -1 ? fragment : fragment.slice(0, atIndex);
    if (name.length > 0 && !/^\d/u.test(name)) {
      return name;
    }
    // Fragment was a bare version: the name is the last path segment.
    const path = packageId.slice(0, hashIndex);
    const segment = path.split('/').at(-1);
    return segment === undefined || segment.length === 0 ? null : segment;
  }
  const spaceIndex = packageId.indexOf(' ');
  if (spaceIndex > 0) {
    return packageId.slice(0, spaceIndex);
  }
  return packageId.length > 0 ? packageId : null;
};

const targetKindsFrom = (value: unknown): readonly string[] => {
  if (!isRecord(value) || !Array.isArray(value.kind)) {
    return [];
  }
  return value.kind.filter((kind): kind is string => typeof kind === 'string');
};

const packageNameFrom = (value: unknown): string | null =>
  typeof value === 'string' ? packageNameFromId(value) : null;

export const parseCargoJsonLine = (line: string): CargoJsonEvent | null => {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || typeof parsed.reason !== 'string') {
    return null;
  }
  switch (parsed.reason) {
    case 'compiler-artifact':
      return {
        kind: 'artifact',
        packageName: packageNameFrom(parsed.package_id),
        targetKinds: targetKindsFrom(parsed.target),
        fresh: parsed.fresh === true,
      };
    case 'compiler-message': {
      const message = isRecord(parsed.message) ? parsed.message : {};
      return {
        kind: 'message',
        packageName: packageNameFrom(parsed.package_id),
        targetKinds: targetKindsFrom(parsed.target),
        level: typeof message.level === 'string' ? message.level : null,
        rendered: typeof message.rendered === 'string' ? message.rendered : null,
      };
    }
    case 'build-finished':
      return { kind: 'build-finished', success: parsed.success === true };
    default:
      return { kind: 'other' };
  }
};

/** Library-shaped target kinds: completing one proves the package's lib unit. */
const libKinds = new Set(['lib', 'rlib', 'dylib', 'cdylib', 'staticlib', 'proc-macro']);

export const hasLibKind = (kinds: Iterable<string>): boolean => {
  for (const kind of kinds) {
    if (libKinds.has(kind)) {
      return true;
    }
  }
  return false;
};
