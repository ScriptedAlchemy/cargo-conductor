import { describe, expect, it } from 'effect-rstest';

import {
  autoBackgroundExitCode,
  hostShellCapMs,
  shellCapHost,
  shouldAutoBackground,
} from '../src/client/host-cap.js';

describe('host shell caps', () => {
  it('uses a Claude cap under the mined 10-minute kill', () => {
    expect(hostShellCapMs('claude')).toBe(9 * 60_000);
    expect(shouldAutoBackground(9 * 60_000 + 1, 'claude', 'ewma')).toBe(true);
    expect(shouldAutoBackground(9 * 60_000, 'claude', 'ewma')).toBe(false);
  });

  it('gives Cursor a longer cap and treats an unknown host like Claude', () => {
    expect(hostShellCapMs('cursor')).toBe(14 * 60_000);
    expect(hostShellCapMs('codex')).toBe(10 * 60_000);
    expect(hostShellCapMs(undefined)).toBe(9 * 60_000);
    expect(shouldAutoBackground(60 * 60_000, undefined, 'ewma')).toBe(false);
  });

  it('never auto-backgrounds on a cold-start default estimate', () => {
    // A `default` prior means "unknown", not "too long": a 500 ms build on a
    // fresh crate was reported as exit 0 without running (#37).
    expect(shouldAutoBackground(60 * 60_000, 'claude', 'default')).toBe(false);
    expect(shouldAutoBackground(60 * 60_000, 'claude', 'kache')).toBe(true);
  });

  it('exposes EX_TEMPFAIL as the auto-background exit code', () => {
    expect(autoBackgroundExitCode).toBe(75);
  });

  it('lets the PATH shim inherit the real host cap from CARGO_HAULER_HOST', () => {
    expect(shellCapHost('shim', { CARGO_HAULER_HOST: 'cursor' })).toBe('cursor');
    expect(shellCapHost('shim', {})).toBe('shim');
    // Hook rewrites already name the host; the environment never overrides them.
    expect(shellCapHost('claude', { CARGO_HAULER_HOST: 'cursor' })).toBe('claude');
    expect(shellCapHost(undefined, { CARGO_HAULER_HOST: 'cursor' })).toBeUndefined();
  });
});
