import { describe, expect, it } from '@rstest/core';

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

  it('accepts conductor flags before an implicit cargo command', () => {
    expect(parseExecArgv(['--cwd', '/tmp/ws', '--bg', 'cargo', 'test'])).toEqual({
      background: true,
      cargoArgv: ['cargo', 'test'],
      cwd: '/tmp/ws',
    });
  });

  it('rejects a missing cargo command, a missing flag value, and an unknown flag', () => {
    expect(() => parseExecArgv([])).toThrow(ExecUsageError);
    expect(() => parseExecArgv(['--session'])).toThrow(/--session requires a value/u);
    expect(() => parseExecArgv(['--unknown', '--', 'cargo', 'check'])).toThrow(/Unknown option: --unknown/u);
    expect(() => parseExecArgv(['--'])).toThrow(/cargo command/u);
  });
});
