import { describe, expect, it } from '@rstest/core';

import { AnsiStreamStripper, colorEnabled, stripAnsi } from '../src/lib/ansi.js';

const ESC = '\u001b';

describe('stripAnsi', () => {
  it('removes rustc-style SGR color from rendered diagnostics', () => {
    const rendered = `${ESC}[0m\n ${ESC}[1m${ESC}[94m--> ${ESC}[0mcrates/store/src/lib.rs:3:5\n`;
    expect(stripAnsi(rendered)).toBe('\n --> crates/store/src/lib.rs:3:5\n');
  });

  it('leaves plain text untouched', () => {
    const text = 'error[E0432]: unresolved import `rusqlite::Connection`\n';
    expect(stripAnsi(text)).toBe(text);
  });

  it('removes a sequence truncated by a tail buffer', () => {
    expect(stripAnsi(`tail text ${ESC}[38;5;`)).toBe('tail text ');
  });

  it('removes OSC sequences with either terminator', () => {
    expect(stripAnsi(`${ESC}]0;title\u0007before ${ESC}]8;;url${ESC}\\after`)).toBe('before after');
  });

  it('never leaves an ESC byte behind', () => {
    const noisy = `a${ESC}b${ESC}[12c${ESC}${ESC}[0md`;
    expect(stripAnsi(noisy)).not.toContain(ESC);
  });
});

describe('AnsiStreamStripper', () => {
  const pushText = (stripper: AnsiStreamStripper, text: string): string =>
    stripper.push(Buffer.from(text)).toString('utf8');

  it('strips complete sequences chunk by chunk', () => {
    const stripper = new AnsiStreamStripper();
    expect(pushText(stripper, `${ESC}[31mred${ESC}[0m`)).toBe('red');
    expect(pushText(stripper, 'plain')).toBe('plain');
  });

  it('holds a sequence split across chunk boundaries', () => {
    const stripper = new AnsiStreamStripper();
    expect(pushText(stripper, `warning${ESC}[38;5;`)).toBe('warning');
    expect(pushText(stripper, '11myellow')).toBe('yellow');
  });

  it('holds a bare trailing ESC until the next chunk', () => {
    const stripper = new AnsiStreamStripper();
    expect(pushText(stripper, `one${ESC}`)).toBe('one');
    expect(pushText(stripper, '[1mtwo')).toBe('two');
  });

  it('passes multi-byte UTF-8 through unchanged across chunk splits', () => {
    const stripper = new AnsiStreamStripper();
    const encoded = Buffer.from(`${ESC}[32m✓ done${ESC}[0m`, 'utf8');
    const out = Buffer.concat([
      stripper.push(encoded.subarray(0, 7)),
      stripper.push(encoded.subarray(7)),
      stripper.flush(),
    ]);
    expect(out.toString('utf8')).toBe('✓ done');
  });

  it('flush drops an unfinished sequence without emitting ESC', () => {
    const stripper = new AnsiStreamStripper();
    expect(pushText(stripper, `end${ESC}[3`)).toBe('end');
    expect(stripper.flush().toString('utf8')).not.toContain(ESC);
  });
});

describe('colorEnabled', () => {
  it('follows TTY-ness when no environment override is set', () => {
    expect(colorEnabled({}, true)).toBe(true);
    expect(colorEnabled({}, false)).toBe(false);
  });

  it('disables on NO_COLOR even for a TTY', () => {
    expect(colorEnabled({ NO_COLOR: '1' }, true)).toBe(false);
    expect(colorEnabled({ NO_COLOR: '' }, true)).toBe(true);
  });

  it('FORCE_COLOR decides outright, beating NO_COLOR', () => {
    expect(colorEnabled({ FORCE_COLOR: '1', NO_COLOR: '1' }, false)).toBe(true);
    expect(colorEnabled({ FORCE_COLOR: '0' }, true)).toBe(false);
  });

  it('honors CLICOLOR conventions and dumb terminals', () => {
    expect(colorEnabled({ CLICOLOR_FORCE: '1' }, false)).toBe(true);
    expect(colorEnabled({ CLICOLOR: '0' }, true)).toBe(false);
    expect(colorEnabled({ TERM: 'dumb' }, true)).toBe(false);
  });
});
