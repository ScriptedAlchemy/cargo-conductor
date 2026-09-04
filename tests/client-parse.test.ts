import { describe, expect, it } from 'effect-rstest';

import { ExecUsageError, parseExecArgv } from '../src/client/parse.js';

describe('parseExecArgv', () => {
  it('treats everything after -- as the cargo command', () => {
    expect(parseExecArgv(['--session', 'sess-1', '--host', 'cursor', '--', 'cargo', 'check', '-p', 'alpha'])).toEqual({
      background: false,
      cargoArgv: ['cargo', 'check', '-p', 'alpha'],
      host: 'cursor',
      session: 'sess-1',
    });
  });

  it('accepts hauler flags before an implicit cargo command', () => {
    expect(parseExecArgv(['--cwd', '/tmp/ws', '--bg', 'cargo', 'test'])).toEqual({
      background: true,
      cargoArgv: ['cargo', 'test'],
      cwd: '/tmp/ws',
    });
  });

  it('collects --after prerequisites, repeated or comma-separated, deduplicated', () => {
    expect(
      parseExecArgv(['--after', 'cc-1,cc-2', '--after', 'cc-3', '--after', 'cc-1', '--bg', '--', 'cargo', 'test']),
    ).toEqual({
      after: ['cc-1', 'cc-2', 'cc-3'],
      background: true,
      cargoArgv: ['cargo', 'test'],
    });
    expect(parseExecArgv(['--', 'cargo', 'test'])).not.toHaveProperty('after');
    expect(() => parseExecArgv(['--after', '--', 'cargo', 'test'])).toThrow(/--after requires a value/u);
    expect(() => parseExecArgv(['--after', ',', '--', 'cargo', 'test'])).toThrow(/--after requires a value/u);
  });

  it('rejects a missing cargo command, a missing flag value, and an unknown flag', () => {
    expect(() => parseExecArgv([])).toThrow(ExecUsageError);
    expect(() => parseExecArgv(['--session'])).toThrow(/--session requires a value/u);
    expect(() => parseExecArgv(['--unknown', '--', 'cargo', 'check'])).toThrow(/Unknown option: --unknown/u);
    expect(() => parseExecArgv(['--'])).toThrow(/cargo command/u);
  });
});
