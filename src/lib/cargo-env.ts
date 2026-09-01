const exactEnvironmentNames = new Set([
  'AR',
  'CC',
  'CFLAGS',
  'CXX',
  'CXXFLAGS',
  'LDFLAGS',
  'PKG_CONFIG_PATH',
]);

const haulerPrefix = 'CARGO_HAULER_';

const targetToolPattern =
  /^(?:AR|CC|CFLAGS|CXX|CXXFLAGS|LDFLAGS)_[A-Za-z0-9_-]+$/u;

export const isRelevantCargoEnvironmentVariable = (name: string): boolean =>
  !name.startsWith(haulerPrefix) &&
  (exactEnvironmentNames.has(name) ||
    name.startsWith('CARGO_') ||
    name.startsWith('RUST') ||
    targetToolPattern.test(name));

/**
 * The caller's color-decision variables (the set `colorEnabled` honors).
 * They ride along to the daemon so the spawned cargo sees the caller's
 * request — the executor turns a caller NO_COLOR into CARGO_TERM_COLOR=never
 * instead of forcing `always`, and nested tools read NO_COLOR/FORCE_COLOR
 * themselves. They are deliberately not identity-relevant: two sessions
 * differing only in TERM or NO_COLOR must still coalesce, so the intent
 * digest (which filters by {@link isRelevantCargoEnvironmentVariable})
 * ignores them.
 */
const colorEnvironmentNames = new Set([
  'CLICOLOR',
  'CLICOLOR_FORCE',
  'FORCE_COLOR',
  'NO_COLOR',
  'TERM',
]);

/** Variables the client ships to the daemon: identity-relevant plus color-decision. */
export const isTransportedEnvironmentVariable = (name: string): boolean =>
  isRelevantCargoEnvironmentVariable(name) || colorEnvironmentNames.has(name);
