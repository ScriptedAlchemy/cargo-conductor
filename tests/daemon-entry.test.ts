import { describe, expect, it } from 'effect-rstest';

import { resolveDaemonEntry } from '../src/client/ensure-daemon.js';

const moduleUrl = 'file:///pkg/dist/bin/cargo-hauler-flight.mjs';
const only = (...paths: string[]) => (path: string) => paths.includes(path);

describe('resolveDaemonEntry', () => {
  it('prefers the artifact script a host injected, as an absolute path', () => {
    expect(
      resolveDaemonEntry({
        argv1: '/art/hooks/before.mjs',
        cwd: '/somewhere',
        env: { CLAUDE_PLUGIN_ROOT: '/art' },
        exists: only('/art/scripts/hauler.mjs', '/pkg/dist/bin/hauler.js'),
        moduleUrl,
      }),
    ).toBe('/art/scripts/hauler.mjs');
  });

  it('resolves a relative plugin root against the client cwd, never the daemon state dir', () => {
    // The daemon is spawned with the state dir as cwd; a relative entry
    // would resolve there and die with MODULE_NOT_FOUND on every hook call.
    expect(
      resolveDaemonEntry({
        argv1: 'scripts/hauler.mjs',
        cwd: '/plugins/hauler',
        env: { PLUGIN_ROOT: '.' },
        exists: only('/plugins/hauler/scripts/hauler.mjs'),
        moduleUrl,
      }),
    ).toBe('/plugins/hauler/scripts/hauler.mjs');
  });

  it('falls back to the package entry beside the module when the plugin script is missing', () => {
    expect(
      resolveDaemonEntry({
        argv1: '/gone/hooks/before.mjs',
        cwd: '/somewhere',
        env: { CLAUDE_PLUGIN_ROOT: '/gone' },
        exists: only('/pkg/dist/bin/hauler.js'),
        moduleUrl,
      }),
    ).toBe('/pkg/dist/bin/hauler.js');
    expect(
      resolveDaemonEntry({
        argv1: undefined,
        cwd: '/somewhere',
        env: {},
        exists: only('/pkg/scripts/hauler.mjs'),
        moduleUrl: 'file:///pkg/hooks/before.mjs',
      }),
    ).toBe('/pkg/scripts/hauler.mjs');
  });

  it('uses the running script only as a last resort, made absolute', () => {
    expect(
      resolveDaemonEntry({
        argv1: 'scripts/hauler.mjs',
        cwd: '/plugins/x',
        env: {},
        exists: () => false,
        moduleUrl,
      }),
    ).toBe('/plugins/x/scripts/hauler.mjs');
    expect(
      resolveDaemonEntry({ argv1: undefined, cwd: '/x', env: {}, exists: () => false, moduleUrl }),
    ).toBe('');
  });
});
