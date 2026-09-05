import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'effect-rstest';

import {
  installCargoShim,
  renderCargoShim,
  resolveRealCargo,
  shimPathStatus,
} from '../src/shim/install.js';

describe('PATH cargo shim', () => {
  it('emits a shim that forwards argv through hauler exec', () => {
    const script = renderCargoShim({
      haulerArgv: ['/usr/bin/node', '/opt/plugin/scripts/hauler.mjs'],
      realCargo: '/usr/bin/cargo',
    });
    expect(script).toContain('#!/bin/sh');
    expect(script).toContain(
      'exec /usr/bin/node /opt/plugin/scripts/hauler.mjs exec --host shim -- /usr/bin/cargo "$@"',
    );
  });

  it('falls back to the real cargo when the embedded hauler entry no longer exists', () => {
    const script = renderCargoShim({
      haulerArgv: ['/usr/bin/node', '/opt/plugin/1.0.0/scripts/hauler.mjs'],
      realCargo: '/usr/bin/cargo',
    });
    // The plugin directory is versioned: an upgrade removes it, and every
    // `cargo` on PATH must keep working rather than fail "No such file".
    expect(script).toContain('[ -f /opt/plugin/1.0.0/scripts/hauler.mjs ] || exec /usr/bin/cargo "$@"');
    expect(script.indexOf('[ -f ')).toBeLessThan(script.indexOf('exec /usr/bin/node'));

    // A PATH `hauler` has no file to test; the guard becomes a lookup.
    const viaPath = renderCargoShim({ haulerArgv: ['hauler'], realCargo: '/usr/bin/cargo' });
    expect(viaPath).toContain('command -v hauler >/dev/null 2>&1 || exec /usr/bin/cargo "$@"');
  });

  it('runs the real cargo when the guard trips', () => {
    const root = mkdtempSync(join(tmpdir(), 'cc-shim-fallback-'));
    try {
      const realCargo = join(root, 'real-cargo');
      writeFileSync(realCargo, '#!/bin/sh\necho "real:$*"\n');
      chmodSync(realCargo, 0o755);
      const shim = join(root, 'cargo');
      writeFileSync(
        shim,
        renderCargoShim({
          haulerArgv: ['/usr/bin/node', join(root, 'missing', 'hauler.mjs')],
          realCargo,
        }),
      );
      chmodSync(shim, 0o755);
      const output = execFileSync(shim, ['check', '-p', 'alpha'], { encoding: 'utf8' });
      expect(output).toBe('real:check -p alpha\n');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('lets cargo spawned by the daemon itself straight through on the one recursion marker', () => {
    const script = renderCargoShim({
      haulerArgv: ['hauler'],
      realCargo: '/usr/bin/cargo',
    });
    // The executor sets CARGO_HAULER_INSIDE=1 on every child it spawns; that
    // is the only marker, and forwarding such a cargo would hand the broker's
    // own work back to the broker.
    expect(script).toContain(
      'if [ -n "${CARGO_HAULER_INSIDE:-}" ]; then\n  exec /usr/bin/cargo "$@"\nfi\n',
    );
    // No second guard variable of any spelling.
    expect(script.match(/CARGO_[A-Z_]+_INSIDE/gu)).toEqual(['CARGO_HAULER_INSIDE']);
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
          haulerArgv: ['hauler'],
          destDir,
          realCargo: '/usr/bin/cargo',
        }),
      ).toThrow(/already exists/u);

      const forced = installCargoShim({
        haulerArgv: ['hauler'],
        destDir,
        force: true,
        realCargo: '/usr/bin/cargo',
      });
      expect(forced.path).toBe(foreign);
      expect(existsSync(foreign)).toBe(true);
      expect(readFileSync(foreign, 'utf8')).toContain(
        'hauler exec --host shim -- /usr/bin/cargo',
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
      // rustup layout: ~/.cargo/bin/cargo is a symlink to the rustup proxy,
      // which dispatches on argv[0]. The link must be embedded, not its target.
      const rustupDir = join(root, 'rustup-bin');
      mkdirSync(rustupDir, { recursive: true });
      writeFileSync(join(rustupDir, 'rustup'), '#!/bin/sh\necho rustup\n');
      symlinkSync('rustup', join(rustupDir, 'cargo'));
      expect(resolveRealCargo('cargo', shimDir, { PATH: `${shimDir}:${rustupDir}` })).toBe(
        join(rustupDir, 'cargo'),
      );

      // installCargoShim wires the resolution in: a bare 'cargo' with only
      // the shim's own dir ahead still embeds the real absolute path.
      const previousPath = process.env.PATH;
      process.env.PATH = `${shimDir}:${realDir}`;
      try {
        const installed = installCargoShim({
          haulerArgv: ['hauler'],
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

  it('refuses to install on win32 with a clear unsupported error', () => {
    const root = mkdtempSync(join(tmpdir(), 'cc-shim-win32-'));
    try {
      const destDir = join(root, 'bin');
      expect(() =>
        installCargoShim({
          haulerArgv: ['hauler'],
          destDir,
          platform: 'win32',
          realCargo: '/usr/bin/cargo',
        }),
      ).toThrow(/not supported on Windows/u);
      // Nothing half-installed: the refusal happens before any writes.
      expect(existsSync(join(destDir, 'cargo'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports whether PATH actually reaches the installed shim', () => {
    const root = mkdtempSync(join(tmpdir(), 'cc-shim-path-'));
    try {
      const shimDir = join(root, 'shims');
      const rustupDir = join(root, 'cargo-bin');
      mkdirSync(shimDir, { recursive: true });
      mkdirSync(rustupDir, { recursive: true });
      const shim = join(shimDir, 'cargo');
      const rustupCargo = join(rustupDir, 'cargo');
      writeFileSync(shim, '#!/bin/sh\n');
      writeFileSync(rustupCargo, '#!/bin/sh\n');

      expect(shimPathStatus(shim, { PATH: `${shimDir}:${rustupDir}` })).toEqual({ kind: 'wins' });
      // rustup's ~/.cargo/bin earlier on PATH: cargo bypasses the shim.
      expect(shimPathStatus(shim, { PATH: `${rustupDir}:${shimDir}` })).toEqual({
        by: rustupCargo,
        kind: 'shadowed',
      });
      expect(shimPathStatus(shim, { PATH: '/nonexistent-dir' })).toEqual({ kind: 'not-on-path' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
