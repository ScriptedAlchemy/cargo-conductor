import { describe, expect, it } from 'effect-rstest';

import { normalizeCargoIntent } from '../src/daemon/intent-normalizer.js';
import { planDemux } from '../src/daemon/job-state.js';

const demuxFlag = '--message-format=json-diagnostic-rendered-ansi';

const plan = (argv: readonly string[]) =>
  planDemux(normalizeCargoIntent({ argv, cwd: '/tmp/ws', env: {}, workspaceRoot: '/tmp/ws' }), argv);

describe('planDemux', () => {
  it('appends the demux flag to a compile without a trailer', () => {
    const planned = plan(['cargo', 'check', '-p', 'alpha']);
    expect(planned.execArgv).toEqual(['cargo', 'check', '-p', 'alpha', demuxFlag]);
    expect(planned.demux).not.toBeNull();
  });

  it('places the demux flag before a `--` trailer so clippy still sees its lint levels (#86)', () => {
    const planned = plan(['cargo', 'clippy', '-p', 'alpha', '--lib', '--', '-D', 'warnings']);
    expect(planned.execArgv).toEqual([
      'cargo',
      'clippy',
      '-p',
      'alpha',
      '--lib',
      demuxFlag,
      '--',
      '-D',
      'warnings',
    ]);
    expect(planned.demux).not.toBeNull();
  });

  it('keeps a caller-chosen message format verbatim and unparsed', () => {
    const argv = ['cargo', 'check', '-p', 'alpha', '--message-format=json'];
    expect(plan(argv)).toEqual({ execArgv: argv, demux: null });
  });

  it('never rewrites execution subcommands', () => {
    const argv = ['cargo', 'test', '-p', 'alpha', '--', 'f1', '--test-threads=4'];
    expect(plan(argv)).toEqual({ execArgv: argv, demux: null });
  });
});
