import type { TailBuffer } from './executor.js';
import { statusOutputPreviewBytes, statusOutputPreviewLines } from './protocol.js';

export interface TailPreviewLimits {
  readonly maxBytes: number;
  readonly maxLines: number;
}

/** The status contract's bounds (`statusOutputPreviewBytes` / `statusOutputPreviewLines`). */
export const statusTailPreviewLimits: TailPreviewLimits = {
  maxBytes: statusOutputPreviewBytes,
  maxLines: statusOutputPreviewLines,
};

/**
 * The last few lines of a live tail, bounded in bytes and lines — what a
 * running `StatusRow` carries as `outputPreview` (#95). Always an exact
 * suffix of `tail.toString()`: when the byte bound cuts a line, the partial
 * leading line is dropped so the preview starts on a line boundary (kept,
 * minus a split character's U+FFFD, only when it is all there is). Null
 * when the tail is empty.
 */
export const tailPreview = (tail: TailBuffer, limits: TailPreviewLimits): string | null => {
  if (tail.byteLength === 0) {
    return null;
  }
  let text = tail.tail(limits.maxBytes);
  if (tail.byteLength > limits.maxBytes) {
    const newline = text.indexOf('\n');
    text =
      newline === -1 || newline === text.length - 1
        ? text.replace(/^\uFFFD+/u, '')
        : text.slice(newline + 1);
  }
  const trailingNewline = text.endsWith('\n');
  const lines = (trailingNewline ? text.slice(0, -1) : text).split('\n');
  if (lines.length > limits.maxLines) {
    text = `${lines.slice(-limits.maxLines).join('\n')}${trailingNewline ? '\n' : ''}`;
  }
  return text.length === 0 ? null : text;
};
