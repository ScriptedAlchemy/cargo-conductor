import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'effect-rstest';

import { realCargoBin } from '../src/daemon/real-cargo.js';

describe('realCargoBin', () => {
  it('honors the explicit override', () => {
    expect(realCargoBin({ CARGO_HAULER_CARGO_BIN: '/opt/rust/cargo' })).toBe('/opt/rust/cargo');
  });

  it('falls back to the daemon’s own CARGO_HAULER_CARGO_BIN when the job env has none', () => {
    // Clients strip CARGO_HAULER_* from the transported env, so in production
    // the per-job env never carries the override; the daemon process does.
    const previous = process.env.CARGO_HAULER_CARGO_BIN;
    process.env.CARGO_HAULER_CARGO_BIN = '/daemon/cargo';
    try {
      expect(realCargoBin({ PATH: '/usr/bin', RUSTFLAGS: '-C opt-level=1' })).toBe('/daemon/cargo');
      // A per-job value still wins over the daemon's.
      expect(realCargoBin({ CARGO_HAULER_CARGO_BIN: '/job/cargo' })).toBe('/job/cargo');
    } finally {
      if (previous === undefined) {
        delete process.env.CARGO_HAULER_CARGO_BIN;
      } else {
        process.env.CARGO_HAULER_CARGO_BIN = previous;
      }
    }
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
