import { describe, expect, it } from 'effect-rstest';

import { hostShellCapMs, shouldAutoBackground } from '../src/client/host-cap.js';

describe('host shell caps', () => {
  it('uses a Claude cap under the mined 10-minute kill', () => {
    expect(hostShellCapMs('claude')).toBe(9 * 60_000);
    expect(shouldAutoBackground(9 * 60_000 + 1, 'claude')).toBe(true);
    expect(shouldAutoBackground(9 * 60_000, 'claude')).toBe(false);
  });

  it('gives Cursor a longer cap and treats an unknown host like Claude', () => {
    expect(hostShellCapMs('cursor')).toBe(14 * 60_000);
    expect(hostShellCapMs('codex')).toBe(10 * 60_000);
    expect(hostShellCapMs(undefined)).toBe(9 * 60_000);
    expect(shouldAutoBackground(60 * 60_000, undefined)).toBe(false);
  });
});
