import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it } from '@rstest/core';

import { findConfiguredTargetDir, locateWorkspaceRoot } from '../src/daemon/workspace.js';

interface TempTree {
  readonly root: string;
  readonly path: (...segments: readonly string[]) => string;
}

const withTree = <A>(files: Readonly<Record<string, string>>, use: (tree: TempTree) => A): A => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cc-workspace-')));
  try {
    for (const [relativePath, contents] of Object.entries(files)) {
      const absolutePath = join(root, relativePath);
      mkdirSync(dirname(absolutePath), { recursive: true });
      writeFileSync(absolutePath, contents);
    }
    return use({ path: (...segments) => join(root, ...segments), root });
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
};

const manifest = '[package]\nname = "demo"\n';

describe('locateWorkspaceRoot', () => {
  it('picks the topmost Cargo.toml above nested members', () => {
    withTree(
      {
        'Cargo.toml': '[workspace]\nmembers = ["crates/*"]\n',
        'crates/alpha/Cargo.toml': manifest,
        'crates/alpha/src/lib.rs': '',
      },
      (tree) => {
        expect(locateWorkspaceRoot(tree.path('crates', 'alpha', 'src'))).toBe(tree.root);
        expect(locateWorkspaceRoot(tree.path('crates', 'alpha'))).toBe(tree.root);
        expect(locateWorkspaceRoot(tree.root)).toBe(tree.root);
      },
    );
  });

  it('falls back to the resolved cwd when no Cargo.toml exists', () => {
    withTree({ 'plain/notes.txt': 'no rust here\n' }, (tree) => {
      expect(locateWorkspaceRoot(join(tree.path('plain'), '.'))).toBe(tree.path('plain'));
    });
  });
});

describe('findConfiguredTargetDir', () => {
  it('finds a target-dir configured at the cwd level', () => {
    withTree(
      {
        'Cargo.toml': manifest,
        'crates/alpha/.cargo/config.toml': '[build]\ntarget-dir = "/shared/target"\n',
      },
      (tree) => {
        expect(findConfiguredTargetDir(tree.path('crates', 'alpha'), tree.root)).toBe(
          '/shared/target',
        );
      },
    );
  });

  it('finds a target-dir configured at the workspace root', () => {
    withTree(
      {
        'Cargo.toml': manifest,
        '.cargo/config.toml': "[build]\ntarget-dir = '/root/target'\n",
        'crates/alpha/src/lib.rs': '',
      },
      (tree) => {
        expect(findConfiguredTargetDir(tree.path('crates', 'alpha', 'src'), tree.root)).toBe(
          '/root/target',
        );
      },
    );
  });

  it('prefers the closest config when several define target-dir', () => {
    withTree(
      {
        'Cargo.toml': manifest,
        '.cargo/config.toml': '[build]\ntarget-dir = "/root/target"\n',
        'crates/alpha/.cargo/config.toml': '[build]\ntarget-dir = "/alpha/target"\n',
      },
      (tree) => {
        expect(findConfiguredTargetDir(tree.path('crates', 'alpha'), tree.root)).toBe(
          '/alpha/target',
        );
      },
    );
  });

  it('resolves a relative target-dir against the directory holding .cargo', () => {
    withTree(
      {
        'Cargo.toml': manifest,
        'crates/alpha/.cargo/config.toml': '[build]\n  target-dir   =   "../shared-target"\n',
      },
      (tree) => {
        expect(findConfiguredTargetDir(tree.path('crates', 'alpha'), tree.root)).toBe(
          tree.path('crates', 'shared-target'),
        );
      },
    );
  });

  it('honors a .cargo/config file without an extension', () => {
    withTree(
      {
        'Cargo.toml': manifest,
        '.cargo/config': '# legacy config\n[build]\ntarget-dir = "legacy-target"\n',
      },
      (tree) => {
        expect(findConfiguredTargetDir(tree.root, tree.root)).toBe(tree.path('legacy-target'));
      },
    );
  });

  it('ignores target-dir declared outside the [build] section', () => {
    withTree(
      {
        'Cargo.toml': manifest,
        '.cargo/config.toml': '[doc]\ntarget-dir = "/doc/target"\n\n[net]\nretry = 2\n',
      },
      (tree) => {
        expect(findConfiguredTargetDir(tree.root, tree.root)).toBeUndefined();
      },
    );
  });

  it('ignores commented-out target-dir entries', () => {
    withTree(
      {
        'Cargo.toml': manifest,
        '.cargo/config.toml': '[build]\n# target-dir = "/commented/target"\njobs = 4\n',
      },
      (tree) => {
        expect(findConfiguredTargetDir(tree.root, tree.root)).toBeUndefined();
      },
    );
  });

  it('does not look above the workspace root', () => {
    withTree(
      {
        '.cargo/config.toml': '[build]\ntarget-dir = "/above/target"\n',
        'workspace/Cargo.toml': manifest,
        'workspace/crates/alpha/src/lib.rs': '',
      },
      (tree) => {
        expect(
          findConfiguredTargetDir(
            tree.path('workspace', 'crates', 'alpha', 'src'),
            tree.path('workspace'),
          ),
        ).toBeUndefined();
      },
    );
  });

  it('returns undefined when no cargo config exists anywhere', () => {
    withTree({ 'Cargo.toml': manifest, 'crates/alpha/src/lib.rs': '' }, (tree) => {
      expect(findConfiguredTargetDir(tree.path('crates', 'alpha', 'src'), tree.root)).toBeUndefined();
    });
  });
});
