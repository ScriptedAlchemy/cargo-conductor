import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'effect-rstest';
import * as Effect from 'effect/Effect';

import { chunkOutput, loadTicketOutput } from '../src/lib/ticket-output.js';

import { scopedTempDir } from './harness.js';

describe('loadTicketOutput', () => {
  it('reports nothing for rows without a log path', () => {
    expect(loadTicketOutput(null, false)).toEqual({ kind: 'none' });
    expect(loadTicketOutput({ outputPath: null }, true)).toEqual({ kind: 'none' });
  });

  it.live('reports a path the row names but the disk no longer has', () =>
    Effect.gen(function* () {
      const root = yield* scopedTempDir('cc-ticket-output-');
      const path = join(root, 'tickets', 'cc-1.log');
      expect(loadTicketOutput({ outputPath: path }, false)).toEqual({ kind: 'missing', path });
      expect(loadTicketOutput({ outputPath: path }, true)).toEqual({ kind: 'missing', path });
    }));

  it.live('reports the file size without reading it unless full is asked', () =>
    Effect.gen(function* () {
      const root = yield* scopedTempDir('cc-ticket-output-');
      mkdirSync(join(root, 'tickets'));
      const path = join(root, 'tickets', 'cc-2.log');
      writeFileSync(path, 'line one\nline two\n');
      expect(loadTicketOutput({ outputPath: path }, false)).toEqual({
        kind: 'available',
        path,
        sizeBytes: 18,
      });
      expect(loadTicketOutput({ outputPath: path }, true)).toEqual({
        kind: 'full',
        omittedBytes: 0,
        path,
        sizeBytes: 18,
        text: 'line one\nline two\n',
      });
    }));

  it.live('strips ANSI from the rendered text, as every structured surface does', () =>
    Effect.gen(function* () {
      const root = yield* scopedTempDir('cc-ticket-output-');
      const path = join(root, 'cc-3.log');
      writeFileSync(path, '\u001b[31merror\u001b[0m: boom\n');
      const output = loadTicketOutput({ outputPath: path }, true);
      expect(output.kind).toBe('full');
      if (output.kind === 'full') {
        expect(output.text).toBe('error: boom\n');
        expect(output.sizeBytes).toBe(Buffer.byteLength('\u001b[31merror\u001b[0m: boom\n'));
      }
    }));

  it.live('keeps the tail of a log that does not fit, starting on a line boundary', () =>
    Effect.gen(function* () {
      const root = yield* scopedTempDir('cc-ticket-output-');
      const path = join(root, 'cc-4.log');
      const lines = Array.from({ length: 200 }, (_, index) => `line ${String(index).padStart(3, '0')}`);
      writeFileSync(path, `${lines.join('\n')}\n`);
      // 200 lines × 9 bytes = 1800 bytes; a 100-byte budget keeps the end.
      const output = loadTicketOutput({ outputPath: path }, true, 100);
      expect(output.kind).toBe('full');
      if (output.kind !== 'full') {
        return;
      }
      expect(output.sizeBytes).toBe(1800);
      expect(output.text.endsWith('line 199\n')).toBe(true);
      expect(output.text.startsWith('line ')).toBe(true);
      // The cut landed mid-line; the fragment before the first newline is dropped.
      expect(output.text.split('\n').filter((line) => line.length > 0).every((line) => /^line \d{3}$/u.test(line))).toBe(true);
      expect(output.omittedBytes).toBe(1800 - Buffer.byteLength(output.text));
      expect(output.omittedBytes).toBeGreaterThanOrEqual(1700);
    }));
});

describe('chunkOutput', () => {
  it('splits at line boundaries into blocks under the byte budget', () => {
    const text = 'aaaa\nbbbb\ncccc\ndddd\n';
    expect(chunkOutput(text, 10)).toEqual(['aaaa\nbbbb', 'cccc\ndddd']);
    expect(chunkOutput(text, 1_000)).toEqual(['aaaa\nbbbb\ncccc\ndddd']);
    expect(chunkOutput('', 10)).toEqual(['']);
    // A single line over the budget stays whole; it is never split mid-line.
    expect(chunkOutput('x'.repeat(30), 10)).toEqual(['x'.repeat(30)]);
  });
});
