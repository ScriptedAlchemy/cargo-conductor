import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'effect-rstest';

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
const workspaceMembersCrates = '[workspace]\nmembers = ["crates/*"]\n';

describe('locateWorkspaceRoot', () => {
  it('resolves a members-glob crate to the workspace root', () => {
    withTree(
      {
        'Cargo.toml': workspaceMembersCrates,
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

  it('keeps a nested standalone package as its own root when it is not a member', () => {
    withTree(
      {
        'Cargo.toml': workspaceMembersCrates,
        'crates/alpha/Cargo.toml': manifest,
        'other/solo/Cargo.toml': '[package]\nname = "solo"\n',
      },
      (tree) => {
        expect(locateWorkspaceRoot(tree.path('other', 'solo'))).toBe(tree.path('other', 'solo'));
        expect(locateWorkspaceRoot(tree.path('other', 'solo', 'src'))).toBe(
          tree.path('other', 'solo'),
        );
        expect(locateWorkspaceRoot(tree.path('crates', 'alpha'))).toBe(tree.root);
      },
    );
  });

  it('parses multiline workspace members and exclude arrays', () => {
    withTree(
      {
        'Cargo.toml':
          '[workspace]\nmembers = [\n  "crates/*",\n  "tools/special",\n]\nexclude = [\n  "crates/skip",\n]\n',
        'crates/alpha/Cargo.toml': manifest,
        'crates/skip/Cargo.toml': '[package]\nname = "skip"\n',
        'tools/special/Cargo.toml': '[package]\nname = "special"\n',
      },
      (tree) => {
        expect(locateWorkspaceRoot(tree.path('crates', 'alpha'))).toBe(tree.root);
        expect(locateWorkspaceRoot(tree.path('tools', 'special'))).toBe(tree.root);
        expect(locateWorkspaceRoot(tree.path('crates', 'skip'))).toBe(tree.path('crates', 'skip'));
      },
    );
  });

  it('respects workspace.exclude even when a members glob would match', () => {
    withTree(
      {
        'Cargo.toml': '[workspace]\nmembers = ["crates/*"]\nexclude = ["crates/skip"]\n',
        'crates/alpha/Cargo.toml': manifest,
        'crates/skip/Cargo.toml': '[package]\nname = "skip"\n',
      },
      (tree) => {
        expect(locateWorkspaceRoot(tree.path('crates', 'alpha'))).toBe(tree.root);
        expect(locateWorkspaceRoot(tree.path('crates', 'skip'))).toBe(tree.path('crates', 'skip'));
      },
    );
  });

  it('honors [package].workspace pointing at an ancestor workspace root', () => {
    withTree(
      {
        'Cargo.toml': '[workspace]\nmembers = ["crates/*"]\n',
        'extra/deep/Cargo.toml': '[package]\nname = "deep"\nworkspace = "../.."\n',
      },
      (tree) => {
        expect(locateWorkspaceRoot(tree.path('extra', 'deep'))).toBe(tree.root);
      },
    );
  });

  it('does not let an unrelated outer Cargo.toml capture an inner workspace', () => {
    withTree(
      {
        'Cargo.toml': '[package]\nname = "home-oops"\n',
        'project/Cargo.toml': workspaceMembersCrates,
        'project/crates/alpha/Cargo.toml': manifest,
        'project/other/solo/Cargo.toml': '[package]\nname = "solo"\n',
      },
      (tree) => {
        const project = tree.path('project');
        expect(locateWorkspaceRoot(tree.path('project', 'crates', 'alpha'))).toBe(project);
        expect(locateWorkspaceRoot(tree.path('project'))).toBe(project);
        expect(locateWorkspaceRoot(tree.path('project', 'other', 'solo'))).toBe(
          tree.path('project', 'other', 'solo'),
        );
        expect(locateWorkspaceRoot(tree.path('project', 'crates', 'alpha'))).not.toBe(tree.root);
      },
    );
  });

  it('stops at the first workspace ancestor and does not adopt a further parent workspace', () => {
    withTree(
      {
        'Cargo.toml': '[workspace]\nmembers = ["*"]\n',
        'project/Cargo.toml': workspaceMembersCrates,
        'project/crates/alpha/Cargo.toml': manifest,
        'project/other/solo/Cargo.toml': '[package]\nname = "solo"\n',
      },
      (tree) => {
        expect(locateWorkspaceRoot(tree.path('project', 'crates', 'alpha'))).toBe(
          tree.path('project'),
        );
        expect(locateWorkspaceRoot(tree.path('project', 'other', 'solo'))).toBe(
          tree.path('project', 'other', 'solo'),
        );
      },
    );
  });

  it('anchors discovery at --manifest-path rather than cwd', () => {
    withTree(
      {
        'unrelated/notes.txt': 'elsewhere\n',
        'project/Cargo.toml': workspaceMembersCrates,
        'project/crates/alpha/Cargo.toml': manifest,
      },
      (tree) => {
        const cwd = tree.path('unrelated');
        const manifestPath = tree.path('project', 'crates', 'alpha', 'Cargo.toml');
        expect(locateWorkspaceRoot(cwd, { manifestPath })).toBe(tree.path('project'));
        expect(
          locateWorkspaceRoot(cwd, {
            argv: ['cargo', 'check', '--manifest-path', manifestPath],
          }),
        ).toBe(tree.path('project'));
        expect(
          locateWorkspaceRoot(cwd, {
            argv: ['cargo', '--manifest-path=../project/crates/alpha/Cargo.toml', 'test'],
          }),
        ).toBe(tree.path('project'));
      },
    );
  });

  it('matches ** members globs across nested package directories', () => {
    withTree(
      {
        'Cargo.toml': '[workspace]\nmembers = ["inner/**"]\n',
        'inner/a/b/Cargo.toml': manifest,
      },
      (tree) => {
        expect(locateWorkspaceRoot(tree.path('inner', 'a', 'b'))).toBe(tree.root);
      },
    );
  });

  it('invalidates the per-anchor cache when a workspace manifest mtime changes', () => {
    withTree(
      {
        'Cargo.toml': workspaceMembersCrates,
        'crates/alpha/Cargo.toml': manifest,
      },
      (tree) => {
        expect(locateWorkspaceRoot(tree.path('crates', 'alpha'))).toBe(tree.root);
        const workspaceManifest = tree.path('Cargo.toml');
        writeFileSync(workspaceManifest, '[workspace]\nmembers = ["other/*"]\n');
        utimesSync(workspaceManifest, new Date(Date.now() + 2000), new Date(Date.now() + 2000));
        expect(locateWorkspaceRoot(tree.path('crates', 'alpha'))).toBe(
          tree.path('crates', 'alpha'),
        );
      },
    );
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

  it('applies CARGO_TARGET_DIR over CARGO_BUILD_TARGET_DIR, --config, and the file', () => {
    withTree(
      {
        'Cargo.toml': manifest,
        '.cargo/config.toml': '[build]\ntarget-dir = "/from-file"\n',
        'crates/alpha/src/lib.rs': '',
      },
      (tree) => {
        const cwd = tree.path('crates', 'alpha');
        const argv = ['cargo', 'check', '--config', 'build.target-dir=/from-config'];
        const fileOnly = findConfiguredTargetDir(cwd, tree.root);
        expect(fileOnly).toBe('/from-file');
        expect(
          findConfiguredTargetDir(cwd, tree.root, {
            argv,
            env: { CARGO_BUILD_TARGET_DIR: '/from-build' },
          }),
        ).toBe('/from-build');
        expect(
          findConfiguredTargetDir(cwd, tree.root, {
            argv,
            env: {
              CARGO_BUILD_TARGET_DIR: '/from-build',
              CARGO_TARGET_DIR: '/from-target-dir',
            },
          }),
        ).toBe('/from-target-dir');
      },
    );
  });

  it('applies --config build.target-dir over workspace-root .cargo/config.toml', () => {
    withTree(
      {
        'Cargo.toml': manifest,
        '.cargo/config.toml': '[build]\ntarget-dir = "/from-file"\n',
      },
      (tree) => {
        expect(
          findConfiguredTargetDir(tree.root, tree.root, {
            argv: ['cargo', 'check', '--config', 'build.target-dir=/from-config'],
          }),
        ).toBe('/from-config');
        expect(
          findConfiguredTargetDir(tree.root, tree.root, {
            argv: ['cargo', 'check', '--config=build.target-dir=/from-equals'],
          }),
        ).toBe('/from-equals');
        expect(
          findConfiguredTargetDir(tree.root, tree.root, {
            argv: ['cargo', 'check', '--config', 'build.target-dir = "/from-quoted"'],
          }),
        ).toBe('/from-quoted');
      },
    );
  });

  it('resolves a relative --config build.target-dir against cwd', () => {
    withTree(
      {
        'Cargo.toml': manifest,
        'crates/alpha/src/lib.rs': '',
      },
      (tree) => {
        expect(
          findConfiguredTargetDir(tree.path('crates', 'alpha'), tree.root, {
            argv: ['cargo', 'check', '--config', 'build.target-dir=scratch'],
          }),
        ).toBe(tree.path('crates', 'alpha', 'scratch'));
      },
    );
  });

  it('does not read process.env when options.env is omitted', () => {
    const previous = process.env.CARGO_TARGET_DIR;
    process.env.CARGO_TARGET_DIR = '/should-not-win';
    try {
      withTree(
        {
          'Cargo.toml': manifest,
          '.cargo/config.toml': '[build]\ntarget-dir = "/from-file"\n',
        },
        (tree) => {
          expect(findConfiguredTargetDir(tree.root, tree.root)).toBe('/from-file');
        },
      );
    } finally {
      if (previous === undefined) {
        delete process.env.CARGO_TARGET_DIR;
      } else {
        process.env.CARGO_TARGET_DIR = previous;
      }
    }
  });
});
