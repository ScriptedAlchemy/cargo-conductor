import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'effect-rstest';
import * as Effect from 'effect/Effect';

import type { RunExecOptions, RunExecResult } from '../src/client/exec.js';
import { runScript, warnRemovedLegacyStateDir } from '../src/scripts/hauler.js';

const run = async (
  argv: readonly string[],
  extras: {
    readonly runExec?: (options: RunExecOptions) => Effect.Effect<RunExecResult>;
    readonly signal?: AbortSignal;
  } = {},
): Promise<{ readonly code: number; readonly text: string }> => {
  const lines: string[] = [];
  const code = await runScript(argv, {
    ...(extras.runExec === undefined ? {} : { runExec: extras.runExec }),
    ...(extras.signal === undefined ? {} : { signal: extras.signal }),
    write: (line) => lines.push(line),
    writeStderr: (data) => lines.push(typeof data === 'string' ? data : Buffer.from(data).toString('utf8')),
    writeStdout: (data) => lines.push(Buffer.from(data).toString('utf8')),
  });
  return { code, text: lines.join('') };
};

const withEnv = async (
  values: Readonly<Record<string, string | undefined>>,
  body: () => Promise<void>,
): Promise<void> => {
  const previous = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]));
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
  try {
    await body();
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
};

describe('hauler script', () => {
  it('warns about the removed legacy state-dir variable, except on the exec hot path', () => {
    const lines: string[] = [];
    const collect = (line: string | Uint8Array) =>
      lines.push(typeof line === 'string' ? line : Buffer.from(line).toString('utf8'));
    const env = { CARGO_CONDUCTOR_STATE_DIR: '/tmp/dead-path' };
    warnRemovedLegacyStateDir(['status'], env, collect);
    expect(lines).toEqual([
      'warning: CARGO_CONDUCTOR_STATE_DIR is no longer supported; use CARGO_HAULER_STATE_DIR instead.\n',
    ]);
    warnRemovedLegacyStateDir(['exec', '--host', 'shim', '--', 'cargo', 'check'], env, collect);
    expect(lines).toHaveLength(1);
  });

  it('prints usage and exits 2 without arguments', async () => {
    const result = await run([]);
    expect(result.code).toBe(2);
    expect(result.text).toContain('Usage: hauler');
    expect(result.text).toContain('exec');
  });

  it('prints usage and exits 0 for --help', async () => {
    const result = await run(['--help']);
    expect(result.code).toBe(0);
    expect(result.text).toContain('Usage: hauler');
    expect(result.text).toContain('daemon');
  });

  it('hands exec the terminal the envelope probed, and nothing when there is none', async () => {
    const terminal = {
      hostSurface: 'script',
      sharesTarget: true,
      stderr: { color: 'basic', kind: 'tty' },
      stdout: { color: 'basic', kind: 'tty' },
    } as const;
    let seen: RunExecOptions | undefined;
    const runExec = (options: RunExecOptions) => {
      seen = options;
      return Effect.succeed({ exitCode: 0, mode: 'brokered' as const });
    };
    await runScript(['exec', '--', 'cargo', 'check'], { runExec, terminal, write: () => undefined });
    expect(seen?.terminal).toBe(terminal);
    await runScript(['exec', '--', 'cargo', 'check'], { runExec, write: () => undefined });
    expect(seen).not.toHaveProperty('terminal');
  });

  it('rejects dashboard arguments outside its grammar with usage and exit 2', async () => {
    for (const argv of [
      ['dashboard', '--port', 'nope'],
      ['dashboard', '--port', '70000'],
      ['dashboard', '--target', 'vscode'],
      ['dashboard', '--open'],
    ]) {
      const result = await run(argv);
      expect(result.code).toBe(2);
      expect(result.text).toContain('Usage: hauler dashboard');
    }
  });

  it('dispatches exec to the streaming client instead of JSON-printing a receipt', async () => {
    let seenArgv: readonly string[] | undefined;
    const result = await run(['exec', '--session', 's1', '--', 'cargo', 'check', '-p', 'alpha'], {
      runExec: (options) => {
        seenArgv = options.argv;
        expect(options.session).toBe('s1');
        return Effect.succeed({ exitCode: 0, mode: 'brokered', ticket: 'cc-9' });
      },
    });
    expect(result.code).toBe(0);
    expect(seenArgv).toEqual(['cargo', 'check', '-p', 'alpha']);
    expect(() => JSON.parse(result.text)).toThrow();
  });

  it('retains legacy host/session metadata because it cannot change state identity', async () => {
    await withEnv(
      {
        CARGO_CONDUCTOR_HOST: 'legacy-host',
        CARGO_CONDUCTOR_SESSION: 'legacy-session',
        CARGO_HAULER_HOST: undefined,
        CARGO_HAULER_SESSION: undefined,
      },
      async () => {
        let seen: RunExecOptions | undefined;
        await run(['exec', '--', 'cargo', 'check'], {
          runExec: (options) => {
            seen = options;
            return Effect.succeed({ exitCode: 0, mode: 'brokered', ticket: 'cc-9' });
          },
        });
        expect(seen?.host).toBe('legacy-host');
        expect(seen?.session).toBe('legacy-session');

        process.env.CARGO_HAULER_HOST = 'current-host';
        process.env.CARGO_HAULER_SESSION = 'current-session';
        await run(['exec', '--', 'cargo', 'check'], {
          runExec: (options) => {
            seen = options;
            return Effect.succeed({ exitCode: 0, mode: 'brokered', ticket: 'cc-10' });
          },
        });
        expect(seen?.host).toBe('current-host');
        expect(seen?.session).toBe('current-session');
      },
    );
  });

  it('passes --after prerequisites to the exec client and documents the flag', async () => {
    let seen: RunExecOptions | undefined;
    const result = await run(['exec', '--after', 'cc-3281,cc-3282', '--bg', '--', 'cargo', 'test', '-p', 'alpha'], {
      runExec: (options) => {
        seen = options;
        return Effect.succeed({ exitCode: 0, mode: 'brokered', ticket: 'cc-3289' });
      },
    });
    expect(result.code).toBe(0);
    expect(seen?.after).toEqual(['cc-3281', 'cc-3282']);
    expect(seen?.background).toBe(true);
    const usage = await run(['--help']);
    expect(usage.text).toContain('--after');
  });

  it('resolves a relative --cwd against the caller, not the daemon', async () => {
    let seen: RunExecOptions | undefined;
    await run(['exec', '--cwd', 'crates/alpha', '--', 'cargo', 'check'], {
      runExec: (options) => {
        seen = options;
        return Effect.succeed({ exitCode: 0, mode: 'brokered', ticket: 'cc-9' });
      },
    });
    // Sent verbatim, a relative path resolved inside the daemon's own cwd.
    expect(seen?.cwd).toBe(resolve('crates/alpha'));
    await run(['exec', '--', 'cargo', 'check'], {
      runExec: (options) => {
        seen = options;
        return Effect.succeed({ exitCode: 0, mode: 'brokered', ticket: 'cc-9' });
      },
    });
    expect(seen?.cwd).toBe(process.cwd());
  });

  it('returns the cargo exit code from exec and rejects a missing cargo command', async () => {
    const failed = await run(['exec', '--', 'cargo', 'test'], {
      runExec: () => Effect.succeed({ exitCode: 17, mode: 'passthrough' }),
    });
    expect(failed.code).toBe(17);

    const usage = await run(['exec']);
    expect(usage.code).toBe(2);
    expect(usage.text).toContain('Usage: hauler');
  });

  it('prints an exec defect and exits 1 instead of leaking a FiberFailure', async () => {
    const result = await run(['exec', '--', 'cargo', 'check'], {
      runExec: () => Effect.die(new SyntaxError('malformed daemon reply')),
    });
    expect(result.code).toBe(1);
    expect(result.text).toContain('malformed daemon reply');
  });

  it('interrupts exec when the abort signal fires', async () => {
    const controller = new AbortController();
    const pending = run(['exec', '--', 'cargo', 'check'], {
      runExec: () =>
        Effect.sleep('200 millis').pipe(Effect.as({ exitCode: 0, mode: 'passthrough' as const })),
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toBeDefined();
  });

  it('answers daemon status natively as one JSON line', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cc-script-daemon-'));
    try {
      await withEnv({ CARGO_HAULER_STATE_DIR: join(root, 'state') }, async () => {
        const result = await run(['daemon', 'status']);
        expect(result.code).toBe(1);
        expect(JSON.parse(result.text)).toMatchObject({
          operation: 'daemon',
          running: false,
          subcommand: 'status',
        });
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('documents daemon restart and rejects unknown daemon subcommands by name', async () => {
    const usage = await run(['--help']);
    expect(usage.text).toContain('daemon <run|start|stop|status|restart>');
    await expect(run(['daemon', 'reload'])).rejects.toThrow('run, start, stop, status, restart');
  });

  it('refuses install-shim with an unknown flag instead of installing anyway', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cc-script-shim-'));
    try {
      const result = await run(['install-shim', '--dir', root, '--help']);
      expect(result.code).toBe(2);
      expect(result.text).toContain('Usage: hauler install-shim');
      expect(existsSync(join(root, 'cargo'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('installs a shim that falls back to cargo when its hauler entry is gone, and says so', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cc-script-shim-'));
    try {
      const result = await run(['install-shim', '--dir', root, '--real-cargo', '/usr/bin/cargo']);
      expect(result.code).toBe(0);
      expect(result.text).toContain(`Installed cargo shim at ${join(root, 'cargo')}`);
      // An upgrade that replaces the plugin directory must not turn every
      // `cargo` on PATH into "No such file"; the operator has to re-run this.
      expect(result.text).toContain('hauler install-shim --force');
      expect(readFileSync(join(root, 'cargo'), 'utf8')).toContain('|| exec /usr/bin/cargo "$@"');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('prints usage for routed commands when the generated CLI is not beside the script', async () => {
    const result = await run(['status']);
    expect(result.code).toBe(2);
    expect(result.text).toContain('cargo-hauler --help');
  });

  const artifactScript = join(import.meta.dirname, '..', 'artifact', 'cursor', 'scripts', 'hauler.mjs');

  it.skipIf(!existsSync(artifactScript))(
    'forwards routed commands to bin/cargo-hauler.mjs inside a built host artifact',
    async () => {
      const stateDir = mkdtempSync(join(tmpdir(), 'cargo-hauler-artifact-'));
      try {
        const child = spawnSync(process.execPath, [artifactScript, 'status', '--json'], {
          encoding: 'utf8',
          env: { ...process.env, CARGO_HAULER_KACHE_INDEX: '', CARGO_HAULER_STATE_DIR: stateDir },
        });
        expect(child.status).toBe(0);
        const parsed: unknown = JSON.parse(child.stdout);
        expect(parsed).toMatchObject({ daemon: 'stopped' });
      } finally {
        rmSync(stateDir, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
