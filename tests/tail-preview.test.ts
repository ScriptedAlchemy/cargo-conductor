import { describe, expect, it } from 'effect-rstest';

import {
  statusOutputPreviewBytes,
  statusOutputPreviewLines,
} from '../src/daemon/protocol.js';
import { TailBuffer } from '../src/daemon/executor.js';
import {
  statusTailPreviewLimits,
  tailPreview,
} from '../src/daemon/tail-preview.js';

const bufferOf = (text: string, capacity = 16 * 1024): TailBuffer => {
  const tail = new TailBuffer(capacity);
  tail.push(Buffer.from(text));
  return tail;
};

/**
 * The status report's live-output preview (#95): the last few lines of a
 * running ticket's tail, bounded in bytes and lines so the report's size
 * follows the number of running tickets, never how much each one printed.
 */
describe('tailPreview', () => {
  it('bounds the default preview at 512 bytes and 8 lines', () => {
    expect(statusTailPreviewLimits).toEqual({ maxBytes: 512, maxLines: 8 });
    expect(statusOutputPreviewBytes).toBe(512);
    expect(statusOutputPreviewLines).toBe(8);
  });

  it('returns null for an empty tail and the whole text when it fits', () => {
    expect(tailPreview(new TailBuffer(1024), statusTailPreviewLimits)).toBeNull();
    expect(tailPreview(bufferOf('   Compiling foo v0.1.0\n'), statusTailPreviewLimits)).toBe(
      '   Compiling foo v0.1.0\n',
    );
    expect(tailPreview(bufferOf('no newline at all'), statusTailPreviewLimits)).toBe('no newline at all');
  });

  it('keeps only the last lines, preserving the trailing newline', () => {
    const text = Array.from({ length: 20 }, (_, index) => `line ${index}`).join('\n');
    expect(tailPreview(bufferOf(`${text}\n`), { maxBytes: 4096, maxLines: 3 })).toBe(
      'line 17\nline 18\nline 19\n',
    );
    expect(tailPreview(bufferOf(text), { maxBytes: 4096, maxLines: 3 })).toBe('line 17\nline 18\nline 19');
  });

  it('starts on a line boundary when the byte bound cuts a line', () => {
    // 20 lines of 10 bytes ("line-000\n" is 9 bytes; pad to 10).
    const lines = Array.from({ length: 20 }, (_, index) => `line-${String(index).padStart(4, '0')}`);
    const text = `${lines.join('\n')}\n`;
    const full = bufferOf(text);
    // 25 bytes back lands in the middle of line-0017; the partial line goes.
    const preview = tailPreview(full, { maxBytes: 25, maxLines: 100 });
    expect(preview).toBe('line-0018\nline-0019\n');
    expect(text.endsWith(preview ?? 'never')).toBe(true);
  });

  it('keeps a partial line when it is all the byte bound leaves', () => {
    const preview = tailPreview(bufferOf(`${'x'.repeat(2_000)}\n`), { maxBytes: 16, maxLines: 8 });
    expect(preview).toBe(`${'x'.repeat(15)}\n`);
    const unterminated = tailPreview(bufferOf('y'.repeat(2_000)), { maxBytes: 16, maxLines: 8 });
    expect(unterminated).toBe('y'.repeat(16));
  });

  it('drops the replacement character a split multi-byte character leaves behind', () => {
    // 'é' is two bytes; cut one byte into it and only U+FFFD would lead.
    const preview = tailPreview(bufferOf('ééééééééé'), { maxBytes: 5, maxLines: 8 });
    expect(preview).toBe('éé');
    expect(preview?.includes('\uFFFD')).toBe(false);
  });

  it('is always an exact suffix of the full tail and within both bounds', () => {
    const words = ['Compiling', 'Checking', 'warning: unused', 'error[E0308]: mismatched types', '   --> src/lib.rs:3:5'];
    let text = '';
    for (let index = 0; index < 1_500; index += 1) {
      text += `${words[index % words.length] ?? ''} ${index} ${'.'.repeat(index % 37)}\n`;
    }
    const full = bufferOf(text, 16 * 1024);
    const whole = full.toString();
    expect(Buffer.byteLength(whole)).toBe(16 * 1024);
    const preview = tailPreview(full, statusTailPreviewLimits);
    expect(preview).not.toBeNull();
    expect(whole.endsWith(preview ?? 'never')).toBe(true);
    expect(Buffer.byteLength(preview ?? '')).toBeLessThanOrEqual(statusOutputPreviewBytes);
    expect((preview ?? '').replace(/\n$/u, '').split('\n').length).toBeLessThanOrEqual(statusOutputPreviewLines);
    // The preview starts on a line boundary of the full tail.
    const start = whole.length - (preview ?? '').length;
    expect(start === 0 || whole[start - 1] === '\n').toBe(true);
  });
});
