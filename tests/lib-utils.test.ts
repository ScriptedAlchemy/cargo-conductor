import { describe, expect, it } from '@rstest/core';

import { namedPackagesInArgv, optionParts } from '../src/lib/argv.js';
import { isRecord } from '../src/lib/guards.js';
import { LineBuffer, parseJsonLines } from '../src/lib/ndjson.js';
import { countWord } from '../src/lib/text.js';
import { parseTicket } from '../src/daemon/protocol.js';

describe('shared micro utilities', () => {
  it('splits inline options and finds named cargo packages', () => {
    expect(optionParts('--package=alpha')).toEqual(['--package', 'alpha']);
    expect(optionParts('--package')).toEqual(['--package', undefined]);
    expect(
      [...namedPackagesInArgv(['cargo', 'check', '-p', 'alpha', '--package=beta'])],
    ).toEqual(['alpha', 'beta']);
  });

  it('recognizes plain records and formats counted words', () => {
    expect(isRecord({ value: 1 })).toBe(true);
    expect(isRecord([])).toBe(false);
    expect(countWord(1, 'warning')).toBe('1 warning');
    expect(countWord(2, 'warning')).toBe('2 warnings');
  });

  it('frames split UTF-8 NDJSON without exposing unterminated data', () => {
    const lines = new LineBuffer();
    const encoded = new TextEncoder().encode('{"value":"café"}\n{"next":2}\n');
    const split = encoded.indexOf(0xc3) + 1;

    expect(lines.push(encoded.subarray(0, split))).toEqual([]);
    expect(lines.push(encoded.subarray(split))).toEqual([
      '{"value":"café"}',
      '{"next":2}',
    ]);
  });

  it('leniently parses valid JSON lines and ignores malformed lines', () => {
    expect(parseJsonLines('{"one":1}\nnot-json\n\n{"two":2}')).toEqual([
      { one: 1 },
      { two: 2 },
    ]);
  });

  it('parses only canonical hauler tickets', () => {
    expect(parseTicket('cc-42')).toBe(42);
    expect(parseTicket('cc-nope')).toBeNull();
    expect(parseTicket('prefix-cc-42')).toBeNull();
  });
});
