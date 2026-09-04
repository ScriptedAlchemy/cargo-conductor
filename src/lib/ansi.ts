/**
 * ANSI escape handling for text that crosses a JSON/non-TTY boundary.
 *
 * Cargo diagnostics are captured through pipes and later surfaced as JSON
 * (`await`/`result`/MCP structured content, the ledger's output tail), where
 * a raw ESC byte gets escaped into a literal `\u001b[…` — noise, not color.
 * These helpers guarantee such surfaces never contain an ESC byte while the
 * live TTY stream keeps its color.
 */

/**
 * One ANSI escape sequence, tolerating truncation: CSI (`ESC [ params
 * intermediates final`), OSC (`ESC ] text BEL|ST`), or any other Fe escape.
 * Final bytes/terminators are optional so a sequence cut off by a tail
 * buffer or end-of-stream is still removed whole; the bare-ESC fallback in
 * the last alternative guarantees no ESC byte survives a replace.
 */
const ansiSequencePattern = new RegExp(
  [
    '\\u001b\\[[0-9:;<=>?]*[ -/]*[@-~]?',
    '\\u001b\\][^\\u0007\\u001b]*(?:\\u0007|\\u001b\\\\)?',
    '\\u001b[@-Z\\\\^_]?',
  ].join('|'),
  'gu',
);

/** A sequence still in progress at end-of-text (no final byte/terminator yet). */
const trailingPartialPattern = new RegExp(
  '\\u001b(?:\\[[0-9:;<=>?]*[ -/]*|\\][^\\u0007\\u001b]*\\u001b?)?$',
  'u',
);

/** Removes every ANSI escape sequence (and any stray ESC byte). */
export const stripAnsi = (text: string): string => text.replace(ansiSequencePattern, '');

/**
 * An unterminated escape sequence longer than this is treated as data, not
 * ANSI, and passed through (protects binary-ish streams from being buffered
 * or eaten by the OSC rule).
 */
const maxHeldLength = 4_096;

/** The escape introducer of an unterminated run reclassified as data. */
const introducerPattern = /^\u001b[[\]]?/u;

/**
 * Strips ANSI from a byte stream chunk by chunk. A sequence split across
 * chunk boundaries is held back until its final byte arrives, so partial
 * escapes never leak through. Bytes are round-tripped through latin1, which
 * preserves them exactly (ANSI sequences are pure ASCII, so multi-byte UTF-8
 * passes through untouched).
 */
export class AnsiStreamStripper {
  #held = '';

  push(data: Uint8Array): Buffer {
    const text = this.#held + Buffer.from(data).toString('latin1');
    const partial = trailingPartialPattern.exec(text);
    if (partial === null) {
      this.#held = '';
      return Buffer.from(stripAnsi(text), 'latin1');
    }
    if (text.length - partial.index <= maxHeldLength) {
      this.#held = text.slice(partial.index);
      return Buffer.from(stripAnsi(text.slice(0, partial.index)), 'latin1');
    }
    // Overlong unterminated run: data, not ANSI. Emit the payload verbatim
    // (stripAnsi would eat an unterminated OSC body whole), dropping only
    // the escape introducer; a trailing ESC may be the start of a real ST
    // terminator, so it stays held — no emission ever contains an ESC byte.
    const run = text.slice(partial.index).replace(introducerPattern, '');
    const holdsEsc = run.endsWith('\u001b');
    this.#held = holdsEsc ? '\u001b' : '';
    const payload = holdsEsc ? run.slice(0, -1) : run;
    return Buffer.from(stripAnsi(text.slice(0, partial.index)) + payload, 'latin1');
  }

  /** Emits whatever a held partial sequence strips down to (usually nothing). */
  flush(): Buffer {
    const held = this.#held;
    this.#held = '';
    return Buffer.from(stripAnsi(held), 'latin1');
  }
}
