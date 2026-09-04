import { performance } from 'node:perf_hooks';

import { describe, expect, it } from 'effect-rstest';

import { LineBuffer, LineBufferOverflowError, defaultMaxLineBytes } from '../src/lib/ndjson.js';

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

describe('LineBuffer bounds', () => {
  it('defaults to a 16 MiB cap on the pending line', () => {
    const buffer = new LineBuffer();
    expect(buffer.maxLineBytes).toBe(16 * 1024 * 1024);
    expect(defaultMaxLineBytes).toBe(16 * 1024 * 1024);
  });

  it('throws once the unterminated line exceeds the cap and drops the pending bytes', () => {
    const buffer = new LineBuffer({ maxLineBytes: 16 });
    expect(buffer.push(encode('0123456789'))).toEqual([]);
    expect(buffer.pendingBytes).toBe(10);
    let thrown: unknown;
    try {
      buffer.push(encode('0123456789'));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(LineBufferOverflowError);
    expect(thrown).toMatchObject({ _tag: 'LineBufferOverflow', maxLineBytes: 16, pendingBytes: 20 });
    expect(buffer.pendingBytes).toBe(0);
    // The buffer is reusable afterwards; the offending bytes are gone.
    expect(buffer.push(encode('{"ok":1}\n'))).toEqual(['{"ok":1}']);
  });

  it('accepts a line exactly at the cap and completes it on the newline', () => {
    const buffer = new LineBuffer({ maxLineBytes: 8 });
    expect(buffer.push(encode('abcd'))).toEqual([]);
    expect(buffer.push(encode('efgh'))).toEqual([]);
    expect(buffer.push(encode('\nnext\n'))).toEqual(['abcdefgh', 'next']);
    expect(buffer.pendingBytes).toBe(0);
  });

  it('counts only the bytes after the last newline as pending', () => {
    const buffer = new LineBuffer({ maxLineBytes: 8 });
    expect(buffer.push(encode('{"a":1}\n{"b":2}\nca'))).toEqual(['{"a":1}', '{"b":2}']);
    expect(buffer.pendingBytes).toBe(2);
    expect(buffer.push(encode('fé\n'))).toEqual(['café']);
  });

  it('appends many small chunks of one long line in linear time', () => {
    const buffer = new LineBuffer();
    const chunk = encode('x'.repeat(64));
    const chunks = 50_000;
    const startedAt = performance.now();
    for (let index = 0; index < chunks; index += 1) {
      expect(buffer.push(chunk)).toEqual([]);
    }
    const [line] = buffer.push(encode('\n'));
    const elapsedMs = performance.now() - startedAt;
    expect(line?.length).toBe(64 * chunks);
    // Re-concatenating the pending text per chunk copies ~80 GB here; a
    // linear append stays in the low hundreds of milliseconds at most.
    expect(elapsedMs).toBeLessThan(2_000);
  });
});
