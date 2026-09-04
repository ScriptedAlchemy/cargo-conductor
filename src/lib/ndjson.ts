import * as Data from 'effect/Data';

/** Pending bytes a `LineBuffer` tolerates before it gives up on the line. */
export const defaultMaxLineBytes = 16 * 1024 * 1024;

export class LineBufferOverflowError extends Data.TaggedError('LineBufferOverflow')<{
  readonly pendingBytes: number;
  readonly maxLineBytes: number;
  readonly message: string;
}> {}

export interface LineBufferOptions {
  readonly maxLineBytes?: number;
}

/**
 * Splits a byte stream into newline-terminated lines. The unterminated tail
 * is kept as decoded pieces (never re-concatenated per chunk, so appends are
 * linear) and bounded by `maxLineBytes`: a peer streaming an endless line
 * gets `LineBufferOverflowError` instead of growing the process heap.
 */
export class LineBuffer {
  readonly #decoder = new TextDecoder();
  readonly #maxLineBytes: number;
  #pending: string[] = [];
  #pendingBytes = 0;

  constructor(options: LineBufferOptions = {}) {
    this.#maxLineBytes =
      options.maxLineBytes !== undefined &&
      Number.isFinite(options.maxLineBytes) &&
      options.maxLineBytes > 0
        ? Math.floor(options.maxLineBytes)
        : defaultMaxLineBytes;
  }

  get maxLineBytes(): number {
    return this.#maxLineBytes;
  }

  /** Bytes held for the current unterminated line. */
  get pendingBytes(): number {
    return this.#pendingBytes;
  }

  push(data: Uint8Array): string[] {
    const text = this.#decoder.decode(data, { stream: true });
    const lines: string[] = [];
    let start = 0;
    let newlineIndex = text.indexOf('\n');
    while (newlineIndex !== -1) {
      const tail = text.slice(start, newlineIndex);
      const line = this.#pending.length === 0 ? tail : `${this.#pending.join('')}${tail}`;
      this.#pending = [];
      this.#pendingBytes = 0;
      if (line.trim().length > 0) {
        lines.push(line);
      }
      start = newlineIndex + 1;
      newlineIndex = text.indexOf('\n', start);
    }
    if (start === 0) {
      // No newline in this chunk: every byte belongs to the pending line.
      if (text.length > 0) {
        this.#pending.push(text);
      }
      this.#pendingBytes += data.byteLength;
    } else if (start < text.length) {
      const rest = text.slice(start);
      this.#pending.push(rest);
      this.#pendingBytes += Buffer.byteLength(rest, 'utf8');
    }
    if (this.#pendingBytes > this.#maxLineBytes) {
      const pendingBytes = this.#pendingBytes;
      this.#pending = [];
      this.#pendingBytes = 0;
      throw new LineBufferOverflowError({
        pendingBytes,
        maxLineBytes: this.#maxLineBytes,
        message: `NDJSON line exceeds ${this.#maxLineBytes} bytes (${pendingBytes} pending without a newline)`,
      });
    }
    return lines;
  }
}

export const parseJsonLines = (text: string): readonly unknown[] => {
  const parsed: unknown[] = [];
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) {
      continue;
    }
    try {
      parsed.push(JSON.parse(line));
    } catch {
      // Lenient readers ignore malformed records and keep scanning.
    }
  }
  return parsed;
};
