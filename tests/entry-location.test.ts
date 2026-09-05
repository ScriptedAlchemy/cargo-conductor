import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';

import { describe, expect, it } from 'effect-rstest';

import {
  globalHaulerArgv,
  haulerEntryLocation,
} from '../src/shim/entry-location.js';

describe('hauler entry location', () => {
  it.each([
    '/home/test/.claude/plugins/cache/cargo-hauler-marketplace/cargo-hauler/1.0.0/scripts/hauler.mjs',
    '/home/test/.codex/plugins/cache/cargo-hauler-marketplace/cargo-hauler/1.0.0/scripts/hauler.mjs',
    '/home/test/.cursor/plugins/local/cargo-hauler/scripts/hauler.mjs',
    '/checkout/artifact/cursor/scripts/hauler.mjs',
  ])('detects host plugin entry %s', (entry) => {
    expect(haulerEntryLocation(entry)).toEqual({
      kind: 'host-plugin',
      path: resolve(entry),
    });
  });

  it('detects a host pack from its routed CLI sibling', () => {
    const root = mkdtempSync(join(tmpdir(), 'cc-entry-location-'));
    try {
      const entry = join(root, 'scripts', 'hauler.mjs');
      mkdirSync(join(root, 'scripts'), { recursive: true });
      mkdirSync(join(root, 'bin'), { recursive: true });
      writeFileSync(entry, '');
      writeFileSync(join(root, 'bin', 'cargo-hauler.mjs'), '');
      expect(haulerEntryLocation(entry)).toEqual({ kind: 'host-plugin', path: realpathSync(entry) });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('detects the npm bin and embeds its own realpath only when PATH has no hauler', () => {
    const root = mkdtempSync(join(tmpdir(), 'cc-entry-npm-'));
    try {
      const entry = join(root, 'lib', 'node_modules', 'cargo-hauler', 'dist', 'bin', 'hauler.js');
      mkdirSync(join(root, 'lib', 'node_modules', 'cargo-hauler', 'dist', 'bin'), {
        recursive: true,
      });
      writeFileSync(entry, '');
      const location = haulerEntryLocation(entry);
      expect(location).toEqual({ kind: 'npm-bin', path: realpathSync(entry) });
      expect(globalHaulerArgv(location, { PATH: '' })).toEqual([process.execPath, realpathSync(entry)]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('prefers the hauler on PATH over a checkout dist/bin/hauler.js', () => {
    const root = mkdtempSync(join(tmpdir(), 'cc-entry-checkout-'));
    try {
      const checkoutEntry = join(root, 'checkout', 'dist', 'bin', 'hauler.js');
      const globalEntry = join(root, 'lib', 'node_modules', 'cargo-hauler', 'dist', 'bin', 'hauler.js');
      const binDir = join(root, 'bin');
      mkdirSync(join(root, 'checkout', 'dist', 'bin'), { recursive: true });
      mkdirSync(join(root, 'lib', 'node_modules', 'cargo-hauler', 'dist', 'bin'), {
        recursive: true,
      });
      mkdirSync(binDir);
      writeFileSync(checkoutEntry, '');
      writeFileSync(globalEntry, '');
      symlinkSync(globalEntry, join(binDir, 'hauler'));
      const location = haulerEntryLocation(checkoutEntry);
      expect(location).toEqual({ kind: 'npm-bin', path: realpathSync(checkoutEntry) });
      expect(globalHaulerArgv(location, { PATH: binDir })).toEqual([
        process.execPath,
        realpathSync(globalEntry),
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('skips PATH entries that are not a node script or resolve into a plugin copy', () => {
    const root = mkdtempSync(join(tmpdir(), 'cc-entry-path-skip-'));
    try {
      // 1: a version-manager shim pointing at a native binary
      const nativeDir = join(root, 'shims');
      mkdirSync(nativeDir);
      writeFileSync(join(root, 'mise'), '');
      symlinkSync(join(root, 'mise'), join(nativeDir, 'hauler'));
      // 2: a wrapper that resolves into a host plugin copy
      const pluginDir = join(root, 'plugin-bin');
      const pluginScript = join(root, '.cursor', 'plugins', 'local', 'cargo-hauler', 'scripts', 'hauler.mjs');
      mkdirSync(pluginDir);
      mkdirSync(join(root, '.cursor', 'plugins', 'local', 'cargo-hauler', 'scripts'), { recursive: true });
      writeFileSync(pluginScript, '');
      symlinkSync(pluginScript, join(pluginDir, 'hauler'));
      // 3: a directory named hauler, and a dangling link
      const dirDir = join(root, 'dir-bin');
      mkdirSync(join(dirDir, 'hauler'), { recursive: true });
      const danglingDir = join(root, 'dangling-bin');
      mkdirSync(danglingDir);
      symlinkSync(join(root, 'missing.js'), join(danglingDir, 'hauler'));
      // 4: the real one, last on PATH
      const globalEntry = join(root, 'lib', 'node_modules', 'cargo-hauler', 'dist', 'bin', 'hauler.js');
      const binDir = join(root, 'bin');
      mkdirSync(join(root, 'lib', 'node_modules', 'cargo-hauler', 'dist', 'bin'), { recursive: true });
      mkdirSync(binDir);
      writeFileSync(globalEntry, '');
      symlinkSync(globalEntry, join(binDir, 'hauler'));

      const path = [nativeDir, pluginDir, dirDir, danglingDir, binDir].join(delimiter);
      expect(globalHaulerArgv({ kind: 'other', path: null }, { PATH: path })).toEqual([
        process.execPath,
        realpathSync(globalEntry),
      ]);
      const withoutGlobal = [nativeDir, pluginDir, dirDir, danglingDir].join(delimiter);
      expect(() => globalHaulerArgv({ kind: 'other', path: null }, { PATH: withoutGlobal })).toThrow(
        'npm i -g cargo-hauler',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails with install guidance when neither PATH nor the entry is a global hauler', () => {
    expect(() => globalHaulerArgv({ kind: 'other', path: '/tmp/anything.js' }, { PATH: '' })).toThrow(
      'npm i -g cargo-hauler',
    );
  });
});
