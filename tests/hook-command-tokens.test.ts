import { describe, expect, it } from 'effect-rstest';

import { commandMentionsHauler } from '../src/hooks/fast-path/tokens.js';

/**
 * The pre-parse test both shell hook entries apply before anything heavy
 * loads. A miss is the dangerous direction (an un-intercepted cargo command
 * bypasses the hauler), so every spelling the rewrite can govern must match;
 * a false positive only costs one in-process parse.
 */
describe('commandMentionsHauler', () => {
  it.each([
    ['cargo test', true],
    ['cd x && cargo build', true],
    ['cargo-hauler status', true],
    ['./scripts/cargo-wrapper build', true],
    ['echo cargo', true],
    ['RUSTFLAGS=-Dwarnings cargo check', true],
    ['CARGO_TARGET_DIR=/tmp/t cargo build', true],
    ['hauler status', true],
    ['hauler exec --session s --host claude -- cargo check', true],
    ['conductor status', true],
    ['~/.cargo/bin/cargo test -p foo', true],
    ['/usr/bin/cargo.exe build', true],
    ['timeout 600 cargo nextest run', true],
    ['cat Cargo.toml', true],
    ['git commit -m "cargo"', true],
    ['cargo', true],
    ['ls -la', false],
    ['git status && pnpm test', false],
    ['CARGO_HOME=/opt/cargo_home ls', false],
    ['mycargo build', false],
    ['echo hauler_status', false],
    ['', false],
    [undefined, false],
  ])('%j → %s', (command, expected) => {
    expect(commandMentionsHauler(command)).toBe(expected);
  });

  it('matches a token on any line of a multi-line command', () => {
    expect(commandMentionsHauler('set -e\nnpm test\ncargo test -p foo\n')).toBe(true);
    expect(commandMentionsHauler('set -e\nnpm test\nls -la\n')).toBe(false);
  });

  it('is a superset of the substring test before-shell applies itself', () => {
    // Every command the rewrite can govern names a word ending in `cargo`
    // (`inspect.ts`), so a token match here is at least as inclusive.
    for (const command of ['cargo build', 'a/cargo build', 'env -u X cargo build', 'while ! cargo build; do :; done']) {
      expect(command.includes('cargo')).toBe(true);
      expect(commandMentionsHauler(command)).toBe(true);
    }
  });
});
