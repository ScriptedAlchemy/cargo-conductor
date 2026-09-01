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
    const holdFrom =
      partial !== null && text.length - partial.index <= maxHeldLength
        ? partial.index
        : text.length;
    this.#held = text.slice(holdFrom);
    return Buffer.from(stripAnsi(text.slice(0, holdFrom)), 'latin1');
  }

  /** Emits whatever a held partial sequence strips down to (usually nothing). */
  flush(): Buffer {
    const held = this.#held;
    this.#held = '';
    return Buffer.from(stripAnsi(held), 'latin1');
  }
}

const isNonZero = (value: string): boolean => value !== '0' && value.toLowerCase() !== 'false';

/**
 * Whether a consumer stream should receive color, following the common
 * precedence: FORCE_COLOR decides outright when set, CLICOLOR_FORCE forces
 * color on, NO_COLOR (any non-empty value) and CLICOLOR=0 force it off,
 * TERM=dumb cannot render color, otherwise color iff the stream is a TTY.
 */
export const colorEnabled = (
  env: Readonly<Record<string, string | undefined>>,
  isTty: boolean,
): boolean => {
  const forceColor = env.FORCE_COLOR;
  if (forceColor !== undefined && forceColor !== '') {
    return isNonZero(forceColor);
  }
  const clicolorForce = env.CLICOLOR_FORCE;
  if (clicolorForce !== undefined && isNonZero(clicolorForce)) {
    return true;
  }
  const noColor = env.NO_COLOR;
  if (noColor !== undefined && noColor !== '') {
    return false;
  }
  if (env.CLICOLOR === '0') {
    return false;
  }
  if (env.TERM === 'dumb') {
    return false;
  }
  return isTty;
};
