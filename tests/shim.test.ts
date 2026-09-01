import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from '@rstest/core';

import { installCargoShim, renderCargoShim, resolveRealCargo } from '../src/shim/install.js';

describe('PATH cargo shim', () => {
  it('emits a shim that forwards argv through conductor exec', () => {
    const script = renderCargoShim({
      conductorArgv: ['/usr/bin/node', '/opt/plugin/scripts/conductor.mjs'],
      realCargo: '/usr/bin/cargo',
    });
    expect(script).toContain('#!/bin/sh');
    expect(script).toContain(
      'exec /usr/bin/node /opt/plugin/scripts/conductor.mjs exec --host shim -- /usr/bin/cargo "$@"',
    );
  });

  it('passes daemon-spawned cargo straight through instead of re-brokering it', () => {
    const script = renderCargoShim({
      conductorArgv: ['conductor'],
      realCargo: '/usr/bin/cargo',
    });
    expect(script).toContain('if [ -n "${CARGO_CONDUCTOR_INSIDE:-}" ]; then');
    expect(script).toContain('  exec /usr/bin/cargo "$@"');
  });

  it('installs an executable shim and refuses to clobber a foreign cargo by default', () => {
    const root = mkdtempSync(join(tmpdir(), 'cc-shim-'));
    try {
      const destDir = join(root, 'bin');
      mkdirSync(destDir, { recursive: true });
      const foreign = join(destDir, 'cargo');
      writeFileSync(foreign, '#!/bin/sh\necho real\n');
      chmodSync(foreign, 0o755);

      expect(() =>
        installCargoShim({
          conductorArgv: ['conductor'],
          destDir,
          realCargo: '/usr/bin/cargo',
        }),
      ).toThrow(/already exists/u);

      const forced = installCargoShim({
        conductorArgv: ['conductor'],
        destDir,
        force: true,
        realCargo: '/usr/bin/cargo',
      });
      expect(forced.path).toBe(foreign);
      expect(existsSync(foreign)).toBe(true);
      expect(readFileSync(foreign, 'utf8')).toContain(
        'conductor exec --host shim -- /usr/bin/cargo',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('always embeds an absolute real cargo, skipping the shim directory itself', () => {
    const root = mkdtempSync(join(tmpdir(), 'cc-shim-'));
    try {
      const shimDir = join(root, 'shims');
      const realDir = join(root, 'real');
      mkdirSync(shimDir, { recursive: true });
      mkdirSync(realDir, { recursive: true });
      // The shim dir already holds a cargo (as it will after installation);
      // the real one lives later on PATH.
      writeFileSync(join(shimDir, 'cargo'), '#!/bin/sh\n');
      const realCargo = join(realDir, 'cargo');
      writeFileSync(realCargo, '#!/bin/sh\necho real\n');
      const env = { PATH: `${shimDir}:${realDir}` };

      // Bare name: resolves through PATH but never onto the shim itself.
      expect(resolveRealCargo('cargo', shimDir, env)).toBe(realCargo);
      // Only the shim on PATH: refuse rather than embed a recursion.
      expect(() => resolveRealCargo('cargo', shimDir, { PATH: shimDir })).toThrow(
        /could not resolve/u,
      );
      // Absolute self-reference: refuse.
      expect(() => resolveRealCargo(join(shimDir, 'cargo'), shimDir, env)).toThrow(
        /points at the shim itself/u,
      );
      // Absolute non-existent path is the operator's call: embedded verbatim.
      expect(resolveRealCargo('/nonexistent/cargo', shimDir, env)).toBe('/nonexistent/cargo');

      // installCargoShim wires the resolution in: a bare 'cargo' with only
      // the shim's own dir ahead still embeds the real absolute path.
      const previousPath = process.env.PATH;
      process.env.PATH = `${shimDir}:${realDir}`;
      try {
        const installed = installCargoShim({
          conductorArgv: ['conductor'],
          destDir: shimDir,
          force: true,
          realCargo: 'cargo',
        });
        expect(readFileSync(installed.path, 'utf8')).toContain(`--host shim -- ${realCargo}`);
      } finally {
        process.env.PATH = previousPath;
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
