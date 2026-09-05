import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

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
      expect(haulerEntryLocation(entry)).toEqual({ kind: 'host-plugin', path: entry });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('detects the npm bin and embeds its own realpath', () => {
    const root = mkdtempSync(join(tmpdir(), 'cc-entry-npm-'));
    try {
      const entry = join(root, 'lib', 'node_modules', 'cargo-hauler', 'dist', 'bin', 'hauler.js');
      mkdirSync(join(root, 'lib', 'node_modules', 'cargo-hauler', 'dist', 'bin'), {
        recursive: true,
      });
      writeFileSync(entry, '');
      const location = haulerEntryLocation(entry);
      expect(location).toEqual({ kind: 'npm-bin', path: entry });
      expect(globalHaulerArgv(location, { PATH: '' })).toEqual([process.execPath, entry]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
