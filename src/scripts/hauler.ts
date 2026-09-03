import { spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as Cause from 'effect/Cause';
import * as Effect from 'effect/Effect';

import { buildRelevantEnv } from '../client/env.js';
import { runExecClient, type RunExecOptions, type RunExecResult } from '../client/exec.js';
import { ExecUsageError, parseExecArgv } from '../client/parse.js';
import { parseDaemonSubcommand, runDaemonControl } from '../daemon/lifecycle.js';
import { resolveHaulerArgv } from '../hooks/paths.js';
import {
  defaultShimDir,
  installCargoShim,
  shimPathStatus,
  type ShimPathStatus,
} from '../shim/install.js';

/**
 * The process-level entry: `exec` owns stdout/stderr byte-for-byte for the
 * cargo stream, `install-shim` embeds its own path, and `daemon` is what the
 * detached spawn re-enters. Everything else is a routed CLI command
 * (`src/cli/**`) and is forwarded to the generated `cargo-hauler` bin when it
 * sits next to this script (the npm package); inside a host artifact only
 * the three process commands exist.
 */
const usage = `Usage: hauler <command>

Commands:
  exec [--session ID] [--host HOST] [--cwd DIR] [--bg] -- <cargo command>
      Run cargo through the hauler daemon
  daemon <run|start|stop|status>
      Control the hauler daemon
  install-shim [--dir DIR] [--real-cargo PATH] [--force]
      Install an optional PATH cargo shim
  status | log | last | await <ticket> | result <ticket> | request -- <cargo command>
      Routed commands; run \`cargo-hauler --help\` for options
`;

export interface ScriptOptions {
  readonly runExec?: (options: RunExecOptions) => Effect.Effect<RunExecResult>;
  readonly signal?: AbortSignal;
  readonly write?: (value: string) => void;
  readonly writeStderr?: (data: string | Uint8Array) => void;
  readonly writeStdout?: (data: Uint8Array) => void;
}

const defaultWrite = (value: string): void => {
  process.stdout.write(value);
};

const defaultWriteStdout = (data: Uint8Array): void => {
  process.stdout.write(data);
};

const defaultWriteStderr = (data: string | Uint8Array): void => {
  process.stderr.write(data);
};

export const warnRemovedLegacyStateDir = (
  env: Readonly<Record<string, string | undefined>> = process.env,
  writeStderr: (data: string | Uint8Array) => void = defaultWriteStderr,
): void => {
  if (env.CARGO_CONDUCTOR_STATE_DIR !== undefined) {
    writeStderr(
      'warning: CARGO_CONDUCTOR_STATE_DIR is no longer supported; use CARGO_HAULER_STATE_DIR instead.\n',
    );
  }
};

/**
 * The shim must never depend on a PATH `hauler` that nothing installs
 * (issue #2): embed the absolute node + script that is running right now.
 */
const selfHaulerArgv = (): readonly string[] => {
  const script = process.argv[1];
  if (script === undefined || script.length === 0) {
    return resolveHaulerArgv();
  }
  let absolute = resolve(script);
  try {
    absolute = realpathSync(absolute);
  } catch {
    // Keep the resolved path when realpath cannot refine it.
  }
  return [process.execPath, absolute];
};

/**
 * PATH honesty at install time: a shim nobody's PATH reaches (rustup's
 * ~/.cargo/bin usually precedes ~/.local/bin) silently bypasses the broker.
 */
const describeShimPathStatus = (status: ShimPathStatus, destDir: string): string => {
  const prepend = `export PATH="${destDir}:$PATH"`;
  switch (status.kind) {
    case 'wins':
      return 'cargo now resolves through the shim; scripted cargo goes through the broker.';
    case 'shadowed':
      return `warning: PATH resolves cargo to ${status.by} before the shim. Put ${destDir} earlier on PATH (e.g. ${prepend} in your shell profile) or the shim never runs.`;
    case 'not-on-path':
      return `warning: ${destDir} is not on PATH. Add it ahead of rustup's ~/.cargo/bin (e.g. ${prepend} in your shell profile) so scripted cargo goes through the broker.`;
    default: {
      const exhaustive: never = status;
      throw new Error(`unhandled shim PATH status: ${JSON.stringify(exhaustive)}`);
    }
  }
};

const runExecCommand = async (argv: readonly string[], options: ScriptOptions): Promise<number> => {
  const write = options.write ?? defaultWrite;
  let parsed;
  try {
    parsed = parseExecArgv(argv);
  } catch (error) {
    if (error instanceof ExecUsageError) {
      write(usage);
      return 2;
    }
    throw error;
  }
  const io = {
    writeStderr: options.writeStderr ?? defaultWriteStderr,
    writeStdout: options.writeStdout ?? defaultWriteStdout,
  };
  const exec = options.runExec ?? runExecClient;
  // The hauler names win; legacy conductor host/session settings remain valid
  // for existing operator wrappers.
  const envHost = process.env.CARGO_HAULER_HOST ?? process.env.CARGO_CONDUCTOR_HOST;
  const envSession = process.env.CARGO_HAULER_SESSION ?? process.env.CARGO_CONDUCTOR_SESSION;
  const session = parsed.session ?? envSession;
  return Effect.runPromise(
    exec({
      argv: parsed.cargoArgv,
      cwd: parsed.cwd ?? process.cwd(),
      env: buildRelevantEnv(process.env),
      host: parsed.host ?? envHost ?? 'cli',
      io,
      ...(parsed.background ? { background: true } : {}),
      ...(session === undefined ? {} : { session }),
    }).pipe(
      Effect.map((result) => result.exitCode),
      Effect.catchCause((cause) =>
        Effect.sync(() => io.writeStderr(`${Cause.pretty(cause)}\n`)).pipe(Effect.as(1)),
      ),
    ),
    { signal: options.signal },
  );
};

const installShimUsage = 'Usage: hauler install-shim [--dir DIR] [--real-cargo PATH] [--force]\n';

const runInstallShim = (rest: readonly string[], write: (value: string) => void): number => {
  const destIndex = rest.indexOf('--dir');
  const destDir = destIndex === -1 ? defaultShimDir() : rest[destIndex + 1];
  const realCargoIndex = rest.indexOf('--real-cargo');
  const realCargo = realCargoIndex === -1 ? 'cargo' : rest[realCargoIndex + 1];
  const consumed = new Set<number>();
  for (const flagIndex of [destIndex, realCargoIndex]) {
    if (flagIndex !== -1) {
      consumed.add(flagIndex).add(flagIndex + 1);
    }
  }
  const unknown = rest.filter((argument, index) => argument !== '--force' && !consumed.has(index));
  if (destDir === undefined || realCargo === undefined || unknown.length > 0) {
    write(installShimUsage);
    return 2;
  }
  try {
    const installed = installCargoShim({
      haulerArgv: selfHaulerArgv(),
      destDir,
      force: rest.includes('--force'),
      realCargo,
    });
    write(`Installed cargo shim at ${installed.path}\n`);
    write(`${describeShimPathStatus(shimPathStatus(installed.path), destDir)}\n`);
    return 0;
  } catch (error) {
    write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
};

const runDaemonCommand = async (
  rest: readonly string[],
  write: (value: string) => void,
): Promise<number> => {
  const result = await runDaemonControl(parseDaemonSubcommand(rest));
  write(`${JSON.stringify(result)}\n`);
  switch (result.subcommand) {
    case 'run':
      return result.message === 'completed' || result.message === 'already-running' ? 0 : 1;
    case 'start':
    case 'status':
      return result.running ? 0 : 1;
    case 'stop':
      return 0;
    default: {
      const exhaustive: never = result.subcommand;
      return exhaustive;
    }
  }
};

/** The generated routed CLI, emitted beside this script in the npm package. */
const routedCliPath = (): string | null => {
  const sibling = fileURLToPath(new URL('./cargo-hauler.js', import.meta.url));
  return existsSync(sibling) ? sibling : null;
};

const forwardToRoutedCli = (argv: readonly string[], options: ScriptOptions): Promise<number> =>
  new Promise((resolvePromise, reject) => {
    const bin = routedCliPath();
    if (bin === null) {
      (options.write ?? defaultWrite)(usage);
      resolvePromise(2);
      return;
    }
    const child = spawn(process.execPath, [bin, ...argv], { stdio: 'inherit' });
    const abort = (): void => {
      child.kill('SIGTERM');
    };
    options.signal?.addEventListener('abort', abort, { once: true });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      options.signal?.removeEventListener('abort', abort);
      resolvePromise(code ?? (signal === null ? 1 : 128));
    });
  });

export const runScript = async (
  argv: readonly string[],
  options: ScriptOptions = {},
): Promise<number> => {
  const write = options.write ?? defaultWrite;
  const [command, ...rest] = argv;
  switch (command) {
    case undefined:
      write(usage);
      return 2;
    case '--help':
    case '-h':
      write(usage);
      return 0;
    case 'exec':
      return runExecCommand(rest, options);
    case 'install-shim':
      return runInstallShim(rest, write);
    case 'daemon':
      return runDaemonCommand(rest, write);
    default:
      return forwardToRoutedCli(argv, options);
  }
};

/**
 * `agent-bundle build` detects the `main` export and generates the process
 * envelope: this module is emitted as `scripts/hauler.mjs` in every host
 * artifact (the hook rewrite target) and as the package `hauler` bin.
 */
export const main = async (argv: readonly string[]): Promise<number> => {
  warnRemovedLegacyStateDir();
  return runScript(argv);
};
