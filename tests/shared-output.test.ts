import { closeSync, mkdtempSync, openSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'effect-rstest';

import { sharesOutputTarget } from '../src/client/shared-output.js';

describe('sharesOutputTarget', () => {
  it('is true when both descriptors refer to the same file (the 2>&1 shape)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cargo-hauler-fd-'));
    const path = join(dir, 'combined.log');
    const a = openSync(path, 'w');
    const b = openSync(path, 'a');
    try {
      expect(sharesOutputTarget(a, b)).toBe(true);
    } finally {
      closeSync(a);
      closeSync(b);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is false for two different files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cargo-hauler-fd-'));
    const a = openSync(join(dir, 'out.log'), 'w');
    const b = openSync(join(dir, 'err.log'), 'w');
    try {
      expect(sharesOutputTarget(a, b)).toBe(false);
    } finally {
      closeSync(a);
      closeSync(b);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is false when a descriptor cannot be inspected', () => {
    expect(sharesOutputTarget(1, 987_654)).toBe(false);
  });
});
