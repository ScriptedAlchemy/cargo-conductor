import { describe, expect, it } from 'effect-rstest';

import { inspectShellCommand, rewriteShellCommand } from '../src/hooks/inspect.js';

const options = { haulerArgv: ['hauler'], host: 'claude', session: 'sess-1' } as const;
const wrap = 'hauler exec --session sess-1 --host claude --';

const rewrite = (command: string): string => rewriteShellCommand(command, options);

describe('shell rewrite round-trip guard', () => {
  it('leaves background jobs untouched because the printer drops `&`', () => {
    for (const command of [
      'nohup cargo build > out.log 2>&1 &',
      'cargo build & pid=$!; wait $pid',
      'cargo build &',
      '(cargo build && cargo test) &',
    ]) {
      expect(rewrite(command)).toBe(command);
    }
  });

  it('still wraps `&&` and `||` lists', () => {
    expect(rewrite('cargo build && cargo test || echo failed')).toBe(
      `${wrap} cargo build && ${wrap} cargo test || echo failed`,
    );
  });

  it('leaves the `time` keyword untouched because the parser consumes it', () => {
    expect(rewrite('time cargo build')).toBe('time cargo build');
    expect(rewrite('time -p cargo build')).toBe('time -p cargo build');
  });

  it('leaves a heredoc that feeds a pipeline or precedes another statement untouched', () => {
    const piped = 'cat <<EOF | cargo run\nhello\nEOF';
    expect(rewrite(piped)).toBe(piped);
    const chained = 'cargo run <<EOF && echo done\nhello\nEOF';
    expect(rewrite(chained)).toBe(chained);
    const followed = 'cargo run <<EOF\nhello\nEOF\ncargo test';
    expect(rewrite(followed)).toBe(followed);
  });

  it('wraps a heredoc that is the sole statement', () => {
    expect(rewrite('cargo run <<EOF\nhello\nEOF')).toBe(`${wrap} cargo run <<EOF\nhello\nEOF\n`);
  });

  it('leaves `|&` pipelines untouched because the printer prints them as `|`', () => {
    expect(rewrite('cargo build |& tee log')).toBe('cargo build |& tee log');
  });

  it('leaves coproc untouched because the printer invents a COPROC name word', () => {
    expect(rewrite('coproc cargo build')).toBe('coproc cargo build');
  });

  it('tolerates the printer canonicalizing separators, redirects, and compound layout', () => {
    expect(rewrite('cargo build; cargo test')).toBe(`${wrap} cargo build;\n${wrap} cargo test`);
    expect(rewrite('cargo build\ncargo test;')).toBe(`${wrap} cargo build;\n${wrap} cargo test`);
    expect(rewrite('cargo build 2>err.log >out.log')).toBe(`${wrap} cargo build 2> err.log > out.log`);
    expect(rewrite('if cargo build; then echo ok; fi')).toBe(`if ${wrap} cargo build; then\n    echo ok;\nfi`);
    expect(rewrite('for p in a b; do cargo test -p $p; done')).toBe(
      `for p in a b;\ndo\n    ${wrap} cargo test -p $p;\ndone`,
    );
    expect(rewrite('cargo build \\\n  --release')).toBe(`${wrap} cargo build --release`);
    expect(rewrite('cargo build # comment')).toBe(`${wrap} cargo build`);
  });
});

describe('shell rewrite coverage', () => {
  it('never passes --cwd; hauler exec inherits the shell cwd', () => {
    expect(rewrite('cd crates/foo && cargo build')).toBe(`cd crates/foo && ${wrap} cargo build`);
    expect(rewrite('(cd sub && cargo test)')).toBe(`( cd sub && ${wrap} cargo test )`);
    expect(rewrite('cargo build')).not.toContain('--cwd');
  });

  it('never wraps command -v, command -V, type, or which lookups', () => {
    expect(rewrite('command -v cargo >/dev/null && cargo build')).toBe(
      `command -v cargo > /dev/null && ${wrap} cargo build`,
    );
    expect(rewrite('command -V cargo')).toBe('command -V cargo');
    expect(rewrite('command -pv cargo')).toBe('command -pv cargo');
    expect(rewrite('CARGO=$(command -v cargo)')).toBe('CARGO=$(command -v cargo)');
    expect(rewrite('type cargo')).toBe('type cargo');
    expect(rewrite('type -P cargo')).toBe('type -P cargo');
    expect(rewrite('which cargo')).toBe('which cargo');
    expect(inspectShellCommand('command -v cargo').hasCargo).toBe(false);
  });

  it('wraps `command cargo …` and `command -p cargo …`', () => {
    expect(rewrite('command cargo build')).toBe(`command ${wrap} cargo build`);
    expect(rewrite('command -p cargo build')).toBe(`command -p ${wrap} cargo build`);
  });

  it('wraps the unbrokered half of a partially wrapped list', () => {
    expect(rewrite('hauler exec -- cargo build && cargo test')).toBe(
      `hauler exec -- cargo build && ${wrap} cargo test`,
    );
    const inspection = inspectShellCommand('hauler exec -- cargo build && cargo test');
    expect(inspection).toEqual({ alreadyWrapped: true, destructive: false, hasCargo: true });
  });

  it('leaves a fully wrapped command alone', () => {
    const command = 'hauler exec --session sess-1 --host claude -- cargo test';
    expect(rewrite(command)).toBe(command);
    expect(inspectShellCommand(command)).toEqual({ alreadyWrapped: true, destructive: false, hasCargo: false });
  });

  it('wraps a negated command in a while loop', () => {
    expect(rewrite('while ! cargo build; do sleep 1; done')).toBe(
      `while ! ${wrap} cargo build; do\n    sleep 1;\ndone`,
    );
  });

  it('wraps cargo behind `rustup run <toolchain> --` and `rustup run --install`', () => {
    expect(rewrite('rustup run stable -- cargo build')).toBe(`rustup run stable -- ${wrap} cargo build`);
    expect(rewrite('rustup run --install nightly cargo check')).toBe(
      `rustup run --install nightly ${wrap} cargo check`,
    );
  });

  it('skips constructs the parser cannot see through', () => {
    for (const command of [
      "find . -name Cargo.toml -exec cargo check --manifest-path {} ';'",
      '$(which cargo) build',
      "'cargo' build",
    ]) {
      expect(rewrite(command)).toBe(command);
    }
  });
});
