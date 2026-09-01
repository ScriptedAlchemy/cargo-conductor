const exactEnvironmentNames = new Set([
  'AR',
  'CC',
  'CFLAGS',
  'CXX',
  'CXXFLAGS',
  'LDFLAGS',
  'PKG_CONFIG_PATH',
]);

const conductorPrefix = 'CARGO_CONDUCTOR_';

const targetToolPattern =
  /^(?:AR|CC|CFLAGS|CXX|CXXFLAGS|LDFLAGS)_[A-Za-z0-9_-]+$/u;

export const isRelevantCargoEnvironmentVariable = (name: string): boolean =>
  !name.startsWith(conductorPrefix) &&
  (exactEnvironmentNames.has(name) ||
    name.startsWith('CARGO_') ||
    name.startsWith('RUST') ||
    targetToolPattern.test(name));
