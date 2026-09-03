import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'effect-rstest';

import { realCargoBin } from '../src/daemon/real-cargo.js';

describe('realCargoBin', () => {
  it('honors the explicit override', () => {
    expect(realCargoBin({ CARGO_HAULER_CARGO_BIN: '/opt/rust/cargo' })).toBe('/opt/rust/cargo');
  });

  it('retains the legacy process override because it cannot change state identity', () => {
    expect(realCargoBin({ CARGO_CONDUCTOR_CARGO_BIN: '/legacy/cargo' })).toBe('/legacy/cargo');
    expect(
      realCargoBin({
        CARGO_CONDUCTOR_CARGO_BIN: '/legacy/cargo',
        CARGO_HAULER_CARGO_BIN: '/current/cargo',
      }),
    ).toBe('/current/cargo');
  });

  it('prefers CARGO_HOME/bin/cargo when it exists', () => {
    const root = mkdtempSync(join(tmpdir(), 'cc-real-cargo-'));
    try {
      const binDir = join(root, 'bin');
      mkdirSync(binDir, { recursive: true });
      writeFileSync(join(binDir, 'cargo'), '#!/bin/sh\n');
      expect(realCargoBin({ CARGO_HOME: root })).toBe(join(binDir, 'cargo'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('falls back to bare cargo when no rustup home exists', () => {
    expect(realCargoBin({ CARGO_HOME: '/nonexistent/cargo-home' })).toBe('cargo');
  });
});
