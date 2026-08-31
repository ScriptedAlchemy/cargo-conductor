import { describe, expect, it } from '@rstest/core';

import { runCli } from '../src/cli.js';

describe('conductor cli', () => {
  it('prints usage and exits 2 without arguments', () => {
    const lines: string[] = [];
    expect(runCli([], (line) => lines.push(line))).toBe(2);
    expect(lines[0]).toContain('Usage: conductor');
  });

  it('prints usage and exits 0 for --help', () => {
    const lines: string[] = [];
    expect(runCli(['--help'], (line) => lines.push(line))).toBe(0);
    expect(lines[0]).toContain('Usage: conductor');
  });

  it('reports scaffold status without claiming the daemon is up', () => {
    const lines: string[] = [];
    expect(runCli(['status'], (line) => lines.push(line))).toBe(0);
    expect(lines.join('')).toContain('daemon is not running');
  });
});
