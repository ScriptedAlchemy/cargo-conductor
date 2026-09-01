import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from '@rstest/core';

import { installCargoShim, renderCargoShim } from '../src/shim/install.js';

describe('PATH cargo shim', () => {
  it('emits a shim that forwards argv through conductor exec', () => {
    const script = renderCargoShim({
      conductorArgv: ['/usr/bin/node', '/opt/plugin/scripts/conductor.mjs'],
      realCargo: '/usr/bin/cargo',
    });
    expect(script).toContain('#!/bin/sh');
    expect(script).toContain('exec /usr/bin/node /opt/plugin/scripts/conductor.mjs exec -- /usr/bin/cargo "$@"');
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
      expect(readFileSync(foreign, 'utf8')).toContain('conductor exec -- /usr/bin/cargo');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
