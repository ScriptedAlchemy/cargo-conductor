import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { AgentTerminal, ExecutableMainContext } from 'agent-bundle';
import * as Cause from 'effect/Cause';
import * as Effect from 'effect/Effect';

import { buildTransportedEnv } from '../client/env.js';
import { runExecClient, type RunExecOptions, type RunExecResult } from '../client/exec.js';
import { ExecUsageError, parseExecArgv } from '../client/parse.js';
import { daemonExitCode, parseDaemonSubcommand, runDaemonControl } from '../daemon/lifecycle.js';
import {
  defaultShimDir,
  installCargoShim,
  shimPathStatus,
  type ShimPathStatus,
} from '../shim/install.js';
import {
  globalHaulerArgv,
  haulerEntryLocation,
  type HaulerEntryLocation,
} from '../shim/entry-location.js';

/**
 * The process-level entry: `exec` owns stdout/stderr byte-for-byte for the
 * cargo stream, `install-shim` embeds the global PATH entry, and `daemon` is
 * what the detached spawn re-enters. Everything else is a routed CLI command
 * (`src/cli/**`) and is forwarded to the generated `cargo-hauler` bin: beside
 * this script in the npm package, or under `bin/` in a host artifact.
 */
const usage = `Usage: hauler <command>

Commands:
  exec [--session ID] [--host HOST] [--cwd DIR] [--bg] [--after TICKET[,TICKET…]] -- <cargo command>
      Run cargo through the hauler daemon; --after queues it until those
      tickets finish (it fails if one of them fails or is killed)
  daemon <run|start|stop|status|restart>
      Control the hauler daemon; restart replaces the running daemon
      (in-flight tickets end killed: "daemon shutdown")
  install-shim [--dir DIR] [--real-cargo PATH] [--force]
      Install an optional PATH cargo shim
  status | log | last | await <ticket> | result <ticket> | request [--after TICKET] -- <cargo command> | dashboard
      Routed commands; run \`cargo-hauler --help\` for options
`;

export interface ScriptOptions {
  /** The running script path and environment; overridable for entry-policy tests. */
  readonly entryPath?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly runExec?: (options: RunExecOptions) => Effect.Effect<RunExecResult>;
  readonly runDaemon?: (argv: readonly string[], write: (value: string) => void) => Promise<number>;
  readonly signal?: AbortSignal;
  /** The process's terminal as the executable envelope probed it; `exec` shapes its output by it. */
  readonly terminal?: AgentTerminal;
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
  const envHost = process.env.CARGO_HAULER_HOST;
  const envSession = process.env.CARGO_HAULER_SESSION;
  const session = parsed.session ?? envSession;
  return Effect.runPromise(
    exec({
      argv: parsed.cargoArgv,
      // Resolved here: the daemon would otherwise resolve a relative --cwd
      // against its own working directory, not the caller's.
      cwd: resolve(parsed.cwd ?? process.cwd()),
      env: buildTransportedEnv(process.env),
      host: parsed.host ?? envHost ?? 'cli',
      io,
      ...(parsed.background ? { background: true } : {}),
      ...(parsed.after === undefined ? {} : { after: parsed.after }),
      ...(session === undefined ? {} : { session }),
      ...(options.terminal === undefined ? {} : { terminal: options.terminal }),
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

const runInstallShim = (
  rest: readonly string[],
  write: (value: string) => void,
  location: HaulerEntryLocation,
  env: Readonly<Record<string, string | undefined>>,
): number => {
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
      haulerArgv: globalHaulerArgv(location, env),
      destDir,
      force: rest.includes('--force'),
      realCargo,
    });
    write(`Installed cargo shim at ${installed.path}\n`);
    write(`${describeShimPathStatus(shimPathStatus(installed.path), destDir)}\n`);
    write(
      `The shim embeds the global hauler entry: ${installed.haulerScript}. If a Node upgrade moves or replaces that file, the shim runs ${installed.realCargo} directly until you re-run \`hauler install-shim --force\`.\n`,
    );
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
  return daemonExitCode(result);
};

export const pluginInstallShimRefusal =
  'hauler install-shim cannot run from a host plugin copy. Install the global CLI with `npm i -g cargo-hauler`, then run `hauler install-shim` from PATH.\n';

export const pluginDirectCliRefusal =
  'This plugin-local scripts/hauler.mjs is for host hooks only. Install the global CLI with `npm i -g cargo-hauler` and use `hauler` on PATH; never run scripts/hauler.mjs directly.\n';

const pluginRootNames = [
  'AGENT_BUNDLE_PLUGIN_ROOT',
  'CLAUDE_PLUGIN_ROOT',
  'CURSOR_PLUGIN_ROOT',
  'PLUGIN_ROOT',
] as const;

const pluginInvocationAllowed = (
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): boolean => {
  if (pluginRootNames.some((name) => (env[name]?.length ?? 0) > 0)) {
    return true;
  }
  const [command, ...rest] = argv;
  if (command === 'daemon' && rest.length === 1 && rest[0] === 'run') {
    return true;
  }
  if (command !== 'exec') {
    return false;
  }
  // Only flags ahead of `--` belong to hauler; `exec -- cargo --host x` is a
  // cargo argv, not a hook rewrite (same boundary as `parseExecArgv`).
  const separator = rest.indexOf('--');
  const flags = separator === -1 ? rest : rest.slice(0, separator);
  const hostIndex = flags.indexOf('--host');
  const host = hostIndex === -1 ? undefined : flags[hostIndex + 1];
  return host !== undefined && host.length > 0;
};

/**
 * The generated routed CLI: `dist/bin/cargo-hauler.js` beside this script in
 * the npm package, or `bin/cargo-hauler.mjs` one level up in a host artifact
 * (where this script lives under `scripts/`).
 */
const routedCliPath = (): string | null => {
  for (const candidate of ['./cargo-hauler.js', '../bin/cargo-hauler.mjs']) {
    const path = fileURLToPath(new URL(candidate, import.meta.url));
    if (existsSync(path)) {
      return path;
    }
  }
  return null;
};

/**
 * Runs `node <script> …` in the foreground with inherited stdio and returns
 * its exit code. A SIGINT/SIGTERM aimed at this process is relayed to the
 * child (a terminal's Ctrl-C reaches both already; `kill <pid>` does not), and
 * an abort becomes the child's SIGTERM.
 */
const forwardToProcess = (argv: readonly string[], options: ScriptOptions): Promise<number> =>
  new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, argv, { stdio: 'inherit' });
    const relaySigint = (): void => {
      child.kill('SIGINT');
    };
    const relaySigterm = (): void => {
      child.kill('SIGTERM');
    };
    process.on('SIGINT', relaySigint);
    process.on('SIGTERM', relaySigterm);
    options.signal?.addEventListener('abort', relaySigterm, { once: true });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      process.off('SIGINT', relaySigint);
      process.off('SIGTERM', relaySigterm);
      options.signal?.removeEventListener('abort', relaySigterm);
      resolvePromise(code ?? (signal === null ? 1 : 128));
    });
  });

const forwardToRoutedCli = (argv: readonly string[], options: ScriptOptions): Promise<number> => {
  const bin = routedCliPath();
  if (bin === null) {
    (options.write ?? defaultWrite)(usage);
    return Promise.resolve(2);
  }
  return forwardToProcess([bin, ...argv], options);
};

export const runScript = async (
  argv: readonly string[],
  options: ScriptOptions = {},
): Promise<number> => {
  const write = options.write ?? defaultWrite;
  const env = options.env ?? process.env;
  const location = haulerEntryLocation(options.entryPath);
  const [command, ...rest] = argv;
  if (location.kind === 'host-plugin' && command === 'install-shim') {
    write(pluginInstallShimRefusal);
    return 1;
  }
  if (location.kind === 'host-plugin' && !pluginInvocationAllowed(argv, env)) {
    write(pluginDirectCliRefusal);
    return 2;
  }
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
      return runInstallShim(rest, write, location, env);
    case 'daemon':
      return (options.runDaemon ?? runDaemonCommand)(rest, write);
    default:
      return forwardToRoutedCli(argv, options);
  }
};

/**
 * `agent-bundle build` detects the `main` export and generates the process
 * envelope: this module is emitted as `scripts/hauler.mjs` in every host
 * artifact (the hook rewrite target) and as the package `hauler` bin. The
 * envelope probes the process's terminal once and hands it in as `context`
 * (agent-bundle#511), so `exec` never inspects `process.stdout` itself.
 */
export const main = async (argv: readonly string[], context: ExecutableMainContext): Promise<number> =>
  runScript(argv, { terminal: context.terminal });
