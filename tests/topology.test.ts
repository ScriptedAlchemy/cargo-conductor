import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from '@rstest/core';

import { newestMtimeMs, parseWorkspaceMetadata, workspaceClosure } from '../src/daemon/topology.js';

const metadataJson = JSON.stringify({
  packages: [
    {
      name: 'leaf',
      manifest_path: '/ws/crates/leaf/Cargo.toml',
      dependencies: [{ name: 'serde' }],
    },
    {
      name: 'mid',
      manifest_path: '/ws/crates/mid/Cargo.toml',
      dependencies: [{ name: 'leaf' }, { name: 'tokio' }],
    },
    {
      name: 'top',
      manifest_path: '/ws/crates/top/Cargo.toml',
      dependencies: [{ name: 'mid' }],
    },
    {
      name: 'island',
      manifest_path: '/ws/crates/island/Cargo.toml',
      dependencies: [],
    },
  ],
});

describe('parseWorkspaceMetadata', () => {
  it('keeps only workspace-internal dependency edges', () => {
    const metadata = parseWorkspaceMetadata(metadataJson);
    expect([...(metadata.directDeps.get('mid') ?? [])]).toEqual(['leaf']);
    expect([...(metadata.directDeps.get('top') ?? [])]).toEqual(['mid']);
    expect(metadata.directDeps.get('leaf')?.size).toBe(0);
    expect(metadata.packageDirs.get('leaf')).toBe('/ws/crates/leaf');
  });

  it('returns an empty graph for malformed output', () => {
    expect(parseWorkspaceMetadata('').directDeps.size).toBe(0);
    expect(parseWorkspaceMetadata('{"no":"packages"}').packageDirs.size).toBe(0);
  });
});

describe('workspaceClosure', () => {
  const metadata = parseWorkspaceMetadata(metadataJson);

  it('computes the transitive closure excluding the requested packages', () => {
    expect([...workspaceClosure(metadata, ['top'])].sort()).toEqual(['leaf', 'mid']);
    expect([...workspaceClosure(metadata, ['mid'])]).toEqual(['leaf']);
    expect(workspaceClosure(metadata, ['leaf']).size).toBe(0);
    expect(workspaceClosure(metadata, ['island']).size).toBe(0);
  });

  it('unions closures across the requested set', () => {
    expect([...workspaceClosure(metadata, ['top', 'island'])].sort()).toEqual(['leaf', 'mid']);
  });
});

describe('newestMtimeMs', () => {
  it('sees edits to existing nested files, not just directory mtimes', () => {
    const root = mkdtempSync(join(tmpdir(), 'cc-topology-'));
    try {
      const src = join(root, 'src', 'nested');
      mkdirSync(src, { recursive: true });
      writeFileSync(join(root, 'Cargo.toml'), '[package]\n');
      writeFileSync(join(src, 'lib.rs'), 'fn old() {}\n');

      // Age everything, then "edit" the nested file in place: only its own
      // mtime moves — parent directory mtimes stay old.
      const oldSeconds = (Date.now() - 60 * 60 * 1000) / 1000;
      for (const path of [root, join(root, 'src'), src, join(root, 'Cargo.toml'), join(src, 'lib.rs')]) {
        utimesSync(path, oldSeconds, oldSeconds);
      }
      const editedSeconds = Date.now() / 1000;
      utimesSync(join(src, 'lib.rs'), editedSeconds, editedSeconds);
      for (const path of [root, join(root, 'src'), src]) {
        utimesSync(path, oldSeconds, oldSeconds);
      }

      const newest = newestMtimeMs(root);
      expect(newest).not.toBeNull();
      expect(newest!).toBeGreaterThan(editedSeconds * 1000 - 5_000);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns null for a directory with nothing to stat', () => {
    const root = mkdtempSync(join(tmpdir(), 'cc-topology-empty-'));
    try {
      expect(newestMtimeMs(join(root, 'missing-package'))).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
