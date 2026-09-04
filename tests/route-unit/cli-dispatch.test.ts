import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'effect-rstest';
import { cliJson, invokeCli } from 'agent-bundle/test';

/**
 * cli-dispatch proof: argv goes through the generated routed-CLI shell in
 * this process — command resolution, option parsing, exit-code policy, and
 * the `--json` projection — with the daemon down in an isolated state dir.
 */
let root = '';
let previousStateDir: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'hauler-cli-dispatch-'));
  previousStateDir = process.env.CARGO_HAULER_STATE_DIR;
  process.env.CARGO_HAULER_STATE_DIR = join(root, 'state');
});

afterEach(() => {
  if (previousStateDir === undefined) {
    delete process.env.CARGO_HAULER_STATE_DIR;
  } else {
    process.env.CARGO_HAULER_STATE_DIR = previousStateDir;
  }
  rmSync(root, { recursive: true, force: true });
});

describe('routed CLI', () => {
  it('lists every command in help and exits 0', async () => {
    const help = await invokeCli(['--help']);
    expect(help.exitCode).toBe(0);
    for (const command of ['status', 'log', 'last', 'await', 'result', 'request', 'kill', 'daemon']) {
      expect(help.stdout).toContain(command);
    }
  });

  it('renders status as Markdown by default and as the canonical JSON value with --json', async () => {
    const rendered = await invokeCli(['status']);
    expect(rendered.exitCode).toBe(0);
    expect(rendered.stdout).toContain('daemon is not running');
    expect(() => JSON.parse(rendered.stdout)).toThrow();

    const json = await invokeCli(['status', '--json', '--limit', '3']);
    expect(json.exitCode).toBe(0);
    expect(cliJson(json)).toMatchObject({ active: [], daemon: 'stopped', operation: 'status' });
  });

  it('maps the legacy filter flags onto the status input', async () => {
    const run = await invokeCli([
      'status',
      '--json',
      '--session',
      's-9',
      '--ticket',
      'cc-1',
      '--ticket',
      'cc-2',
      '--status',
      'running',
      '--lane',
      'ws:target',
      '--command-contains',
      'check',
    ]);
    expect(run.exitCode).toBe(0);
    expect(cliJson(run)).toMatchObject({ operation: 'status', recent: [] });
  });

  it('rejects an unknown status value and a missing ticket as usage failures', async () => {
    const badStatus = await invokeCli(['status', '--status', 'sleeping']);
    expect(badStatus.exitCode).toBe(2);

    const missingTicket = await invokeCli(['result']);
    expect(missingTicket.exitCode).toBe(2);
    expect(missingTicket.stderr).toContain('ticket');
  });

  it('reports the daemon as stopped through the result exit-code policy', async () => {
    const run = await invokeCli(['daemon', 'status']);
    expect(run.exitCode).toBe(1);
    expect(cliJson(run)).toMatchObject({
      operation: 'daemon',
      running: false,
      subcommand: 'status',
    });
  });

  it('fails ticket lookups with the daemon down instead of pretending not-found', async () => {
    const run = await invokeCli(['result', 'cc-1']);
    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain('daemon unreachable');
  });

  it('accepts result --full as a flag and still needs the ticket', async () => {
    const help = await invokeCli(['result', '--help']);
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain('--full');

    // Parsed as a flag (not a usage error); the lookup itself needs the daemon.
    const full = await invokeCli(['result', 'cc-1', '--full']);
    expect(full.exitCode).toBe(1);
    expect(full.stderr).toContain('daemon unreachable');

    const withValue = await invokeCli(['result', 'cc-1', '--full=yes']);
    expect(withValue.exitCode).toBe(2);

    const missingTicket = await invokeCli(['result', '--full']);
    expect(missingTicket.exitCode).toBe(2);
    expect(missingTicket.stderr).toContain('ticket');
  });

  it('requires the cargo argv after -- for request', async () => {
    // The live submit path is covered in routes.test.ts against a daemon; a
    // cold submit here would spawn `daemon run` from the test runner itself.
    const run = await invokeCli(['request', '--session', 's-1']);
    expect(run.exitCode).toBe(2);
    expect(run.stderr).toContain('argv');
  });
});
