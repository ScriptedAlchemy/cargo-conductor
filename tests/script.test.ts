import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'effect-rstest';
import * as Effect from 'effect/Effect';

import type { RunExecOptions, RunExecResult } from '../src/client/exec.js';
import {
  pluginDirectCliRefusal,
  pluginInstallShimRefusal,
  runScript,
  type ScriptOptions,
} from '../src/scripts/hauler.js';

const run = async (
  argv: readonly string[],
  extras: Pick<ScriptOptions, 'entryPath' | 'env' | 'runDaemon' | 'runExec' | 'signal'> = {},
): Promise<{ readonly code: number; readonly text: string }> => {
  const lines: string[] = [];
  const code = await runScript(argv, {
    ...(extras.entryPath === undefined ? {} : { entryPath: extras.entryPath }),
    ...(extras.env === undefined ? {} : { env: extras.env }),
    ...(extras.runDaemon === undefined ? {} : { runDaemon: extras.runDaemon }),
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

  it('reads the exec host and session from CARGO_HAULER_HOST and CARGO_HAULER_SESSION', async () => {
    await withEnv(
      { CARGO_HAULER_HOST: 'env-host', CARGO_HAULER_SESSION: 'env-session' },
      async () => {
        let seen: RunExecOptions | undefined;
        await run(['exec', '--', 'cargo', 'check'], {
          runExec: (options) => {
            seen = options;
            return Effect.succeed({ exitCode: 0, mode: 'brokered', ticket: 'cc-9' });
          },
        });
        expect(seen?.host).toBe('env-host');
        expect(seen?.session).toBe('env-session');

        // Explicit flags win over the environment.
        await run(['exec', '--session', 'flag-session', '--host', 'flag-host', '--', 'cargo', 'check'], {
          runExec: (options) => {
            seen = options;
            return Effect.succeed({ exitCode: 0, mode: 'brokered', ticket: 'cc-10' });
          },
        });
        expect(seen?.host).toBe('flag-host');
        expect(seen?.session).toBe('flag-session');
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

  const pluginScript = '/home/test/.cursor/plugins/local/cargo-hauler/scripts/hauler.mjs';

  it('refuses install-shim from a plugin copy with the global install guidance', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cc-script-shim-refusal-'));
    try {
      const result = await run(['install-shim', '--dir', root], { entryPath: pluginScript });
      expect(result).toEqual({ code: 1, text: pluginInstallShimRefusal });
      expect(existsSync(join(root, 'cargo'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('embeds the realpath of the hauler command found on PATH', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cc-script-global-hauler-'));
    try {
      const binDir = join(root, 'bin');
      const globalScript = join(root, 'lib', 'node_modules', 'cargo-hauler', 'dist', 'bin', 'hauler.js');
      const shimDir = join(root, 'shim');
      mkdirSync(join(root, 'lib', 'node_modules', 'cargo-hauler', 'dist', 'bin'), {
        recursive: true,
      });
      mkdirSync(binDir, { recursive: true });
      writeFileSync(globalScript, '#!/usr/bin/env node\n');
      symlinkSync(globalScript, join(binDir, 'hauler'));
      const result = await run(
        ['install-shim', '--dir', shimDir, '--real-cargo', '/usr/bin/cargo'],
        {
          entryPath: join(root, 'checkout', 'scripts', 'hauler.mjs'),
          env: { PATH: binDir },
        },
      );
      expect(result.code).toBe(0);
      expect(readFileSync(join(shimDir, 'cargo'), 'utf8')).toContain(
        `exec ${process.execPath} ${realpathSync(join(binDir, 'hauler'))} exec --host shim -- /usr/bin/cargo "$@"`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses direct plugin CLI use but preserves hook and daemon invocations', async () => {
    const refused = await run(['status'], { entryPath: pluginScript });
    expect(refused).toEqual({ code: 2, text: pluginDirectCliRefusal });

    let execCalled = false;
    const exec = await run(['exec', '--host', 'cursor', '--', 'cargo', 'check'], {
      entryPath: pluginScript,
      runExec: () => {
        execCalled = true;
        return Effect.succeed({ exitCode: 0, mode: 'brokered' });
      },
    });
    expect(exec).toEqual({ code: 0, text: '' });
    expect(execCalled).toBe(true);

    let daemonArgv: readonly string[] | undefined;
    const daemon = await run(['daemon', 'run'], {
      entryPath: pluginScript,
      runDaemon: async (argv) => {
        daemonArgv = argv;
        return 0;
      },
    });
    expect(daemon).toEqual({ code: 0, text: '' });
    expect(daemonArgv).toEqual(['run']);

    const hook = await run(['--help'], {
      entryPath: pluginScript,
      env: { CLAUDE_PLUGIN_ROOT: '/plugin' },
    });
    expect(hook.code).toBe(0);
    expect(hook.text).toContain('Usage: hauler');
  });

  it('refuses plugin exec without a --host ahead of `--`, and install-shim even under a plugin root', async () => {
    let execCalled = false;
    const runExec: ScriptOptions['runExec'] = () => {
      execCalled = true;
      return Effect.succeed({ exitCode: 0, mode: 'brokered' });
    };
    const bare = await run(['exec', '--', 'cargo', 'check'], { entryPath: pluginScript, runExec });
    expect(bare).toEqual({ code: 2, text: pluginDirectCliRefusal });
    const hostAfterSeparator = await run(['exec', '--', 'cargo', '--host', 'cursor'], {
      entryPath: pluginScript,
      runExec,
    });
    expect(hostAfterSeparator).toEqual({ code: 2, text: pluginDirectCliRefusal });
    expect(execCalled).toBe(false);

    const root = mkdtempSync(join(tmpdir(), 'cc-script-shim-root-'));
    try {
      for (const name of ['CURSOR_PLUGIN_ROOT', 'PLUGIN_ROOT']) {
        const result = await run(['install-shim', '--dir', root], {
          entryPath: pluginScript,
          env: { [name]: '/plugin' },
        });
        expect(result).toEqual({ code: 1, text: pluginInstallShimRefusal });
      }
      expect(existsSync(join(root, 'cargo'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('runs every command from the npm bin entry without a refusal', async () => {
    const npmEntry = '/home/test/.local/share/mise/installs/node/22/lib/node_modules/cargo-hauler/dist/bin/hauler.js';
    const help = await run(['--help'], { entryPath: npmEntry });
    expect(help.code).toBe(0);
    expect(help.text).toContain('Usage: hauler');
    let execCalled = false;
    const exec = await run(['exec', '--', 'cargo', 'check'], {
      entryPath: npmEntry,
      runExec: () => {
        execCalled = true;
        return Effect.succeed({ exitCode: 0, mode: 'brokered' });
      },
    });
    expect(exec).toEqual({ code: 0, text: '' });
    expect(execCalled).toBe(true);
  });

  it('installs a shim that falls back to cargo when its hauler entry is gone, and says so', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cc-script-shim-'));
    try {
      // An npm bin with no other `hauler` on PATH embeds itself; the embedded
      // file does not exist here, which is exactly the post-Node-upgrade state.
      const goneEntry = join(root, 'lib', 'node_modules', 'cargo-hauler', 'dist', 'bin', 'hauler.js');
      const result = await run(['install-shim', '--dir', root, '--real-cargo', '/usr/bin/cargo'], {
        entryPath: goneEntry,
        env: { PATH: '' },
      });
      expect(result.code).toBe(0);
      expect(result.text).toContain(`Installed cargo shim at ${join(root, 'cargo')}`);
      // A Node upgrade that moves the global entry must not turn every `cargo`
      // on PATH into "No such file"; the operator has to re-run this.
      expect(result.text).toContain('hauler install-shim --force');
      expect(readFileSync(join(root, 'cargo'), 'utf8')).toContain('|| exec /usr/bin/cargo "$@"');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails install-shim with install guidance when no global hauler exists', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cc-script-shim-none-'));
    try {
      const result = await run(['install-shim', '--dir', root, '--real-cargo', '/usr/bin/cargo'], {
        entryPath: join(root, 'somewhere', 'hauler.mjs'),
        env: { PATH: '' },
      });
      expect(result.code).toBe(1);
      expect(result.text).toContain('npm i -g cargo-hauler');
      expect(existsSync(join(root, 'cargo'))).toBe(false);
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
    'refuses routed commands from a built host artifact',
    async () => {
      const stateDir = mkdtempSync(join(tmpdir(), 'cargo-hauler-artifact-'));
      try {
        const child = spawnSync(process.execPath, [artifactScript, 'status', '--json'], {
          encoding: 'utf8',
          env: { ...process.env, CARGO_HAULER_KACHE_INDEX: '', CARGO_HAULER_STATE_DIR: stateDir },
        });
        expect(child.status).toBe(2);
        expect(child.stdout).toBe(pluginDirectCliRefusal);
      } finally {
        rmSync(stateDir, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
