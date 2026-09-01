import { describe, expect, it } from '@rstest/core';

import { parseWorkspaceMetadata, workspaceClosure } from '../src/daemon/topology.js';

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
