import { spawn } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { AgentTerminal, ExecutableMainContext } from 'agent-bundle';
import * as Cause from 'effect/Cause';
import * as Effect from 'effect/Effect';

import { buildTransportedEnv } from '../client/env.js';
import { runExecClient, type RunExecOptions, type RunExecResult } from '../client/exec.js';
import { ExecUsageError, parseExecArgv } from '../client/parse.js';
import { daemonExitCode, parseDaemonSubcommand, runDaemonControl } from '../daemon/lifecycle.js';
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
 * (`src/cli/**`) and is forwarded to the generated `cargo-hauler` bin: beside
 * this script in the npm package, or under `bin/` in a host artifact.
 */
const usage = `Usage: hauler <command>

Commands:
  exec [--session ID] [--host HOST] [--cwd DIR] [--bg] [--after TICKET[,TICKET…]] -- <cargo command>
      Run cargo through the hauler daemon; --after queues it until those
      tickets finish (it fails if one of them fails or is killed)
  daemon <run|start|stop|status|restart>
      Control the hauler daemon; restart replaces a daemon left running from
      an older install (in-flight tickets end as "orphaned by daemon restart")
  install-shim [--dir DIR] [--real-cargo PATH] [--force]
      Install an optional PATH cargo shim
  dashboard [--target HOST] [--port N] [--no-open]
      Serve the dashboard App in a plain browser tab against the running
      daemon (from the plugin checkout or the npm package) until Ctrl-C
  status | log | last | await <ticket> | result <ticket> | request [--after TICKET] -- <cargo command>
      Routed commands; run \`cargo-hauler --help\` for options
`;

export interface ScriptOptions {
  readonly runExec?: (options: RunExecOptions) => Effect.Effect<RunExecResult>;
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
 * `exec` is the shim/hook hot path: its stderr lands in an agent's tool output
 * on every cargo call, so the reminder about the removed variable is only
 * printed for commands a person runs by hand.
 */
export const warnRemovedLegacyStateDir = (
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>> = process.env,
  writeStderr: (data: string | Uint8Array) => void = defaultWriteStderr,
): void => {
  if (argv[0] !== 'exec' && env.CARGO_CONDUCTOR_STATE_DIR !== undefined) {
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
    write(
      `The shim embeds this hauler entry: ${installed.haulerScript}. After an upgrade that moves or replaces that directory, the shim runs ${installed.realCargo} directly until you re-run \`hauler install-shim --force\`.\n`,
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

const dashboardUsage = 'Usage: hauler dashboard [--target claude|codex|cursor|portable] [--port N] [--no-open]\n';

const dashboardTargets = ['claude', 'codex', 'cursor', 'portable'] as const;

type DashboardTarget = (typeof dashboardTargets)[number];

const isDashboardTarget = (value: string): value is DashboardTarget =>
  (dashboardTargets as readonly string[]).includes(value);

interface DashboardArgv {
  readonly open: boolean;
  readonly port?: number;
  readonly target: DashboardTarget;
}

const parseDashboardArgv = (rest: readonly string[]): DashboardArgv | undefined => {
  let open = true;
  let port: number | undefined;
  let target: DashboardTarget = 'portable';
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    switch (argument) {
      case '--no-open':
        open = false;
        break;
      case '--port': {
        const value = Number(rest[index + 1]);
        if (!Number.isInteger(value) || value < 0 || value > 65_535) {
          return undefined;
        }
        port = value;
        index += 1;
        break;
      }
      case '--target': {
        const value = rest[index + 1];
        if (value === undefined || !isDashboardTarget(value)) {
          return undefined;
        }
        target = value;
        index += 1;
        break;
      }
      default:
        return undefined;
    }
  }
  return { open, ...(port === undefined ? {} : { port }), target };
};

/**
 * Where this entry lives decides what it can serve: `dist/bin/hauler.js` sits
 * two levels under the project root (a checkout or the npm package), whose
 * `artifact/` holds every built host pack; `artifact/<host>/scripts/hauler.mjs`
 * sits two levels under that artifact root. An installed host pack is neither
 * and has no artifact to serve from.
 */
const locateDashboardProject = (): { readonly artifact: string; readonly root: string } | undefined => {
  const here = fileURLToPath(new URL('../../', import.meta.url));
  if (existsSync(join(here, 'agent-bundle.manifest.json'))) {
    return { artifact: here, root: dirname(here) };
  }
  if (existsSync(join(here, 'artifact', 'agent-bundle.manifest.json'))) {
    return { artifact: join(here, 'artifact'), root: here };
  }
  return undefined;
};

/**
 * The framework's own CLI as the project resolves it: the `agent-bundle`
 * package under the nearest `node_modules` at or above the root, read from its
 * manifest's `bin`. Looked up by path, not `require.resolve`: the package's
 * `exports` declare no `require` condition, and an `import()` of it here
 * would drag the framework into every bundle that carries this entry.
 */
const frameworkCliPath = (root: string): string | undefined => {
  for (let directory = root; ; directory = dirname(directory)) {
    const packageDir = join(directory, 'node_modules', 'agent-bundle');
    const manifestPath = join(packageDir, 'package.json');
    if (existsSync(manifestPath)) {
      const manifest: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'));
      const bin = typeof manifest === 'object' && manifest !== null && 'bin' in manifest ? manifest.bin : undefined;
      const relative =
        typeof bin === 'string' ? bin : typeof bin === 'object' && bin !== null ? Reflect.get(bin, 'agent-bundle') : undefined;
      return typeof relative === 'string' ? resolve(packageDir, relative) : undefined;
    }
    if (directory === dirname(directory)) {
      return undefined;
    }
  }
};

/**
 * `hauler dashboard`: the MCP App in a plain browser tab, outside any MCP
 * host. It runs the framework's own `agent-bundle serve-app` (agent-bundle#514)
 * against this install's built artifact: the packed `hauler` server launches
 * exactly as `mcp run` launches it, the App is bound to it through the
 * Workbench's host stack on a loopback origin, `hauler_status` is called once
 * so it opens populated, and `call-tool` is approved so the panels may poll;
 * the command stays in the foreground until Ctrl-C or the server exits.
 *
 * The framework is spawned, never imported: a routed command importing
 * `agent-bundle/api` would either inline the framework into every host pack's
 * bin or leave a bare import the artifact validator rejects (`AB6005`). The
 * packs stay self-contained, and `agent-bundle` is resolved from the project
 * at run time — the checkout (or an install that adds it) has it; an
 * installed host pack does not, and says so.
 */
const runDashboard = (rest: readonly string[], options: ScriptOptions): Promise<number> => {
  const write = options.write ?? defaultWrite;
  const writeStderr = options.writeStderr ?? defaultWriteStderr;
  const argv = parseDashboardArgv(rest);
  if (argv === undefined) {
    write(dashboardUsage);
    return Promise.resolve(2);
  }
  const project = locateDashboardProject();
  if (project === undefined) {
    writeStderr(
      'hauler dashboard runs from the plugin checkout or the npm package, where the built artifact sits beside the CLI; an installed host pack has none. In an MCP host, call hauler_status instead — the dashboard App is attached to its result.\n',
    );
    return Promise.resolve(1);
  }
  const cli = frameworkCliPath(project.root);
  if (cli === undefined) {
    writeStderr(
      `hauler dashboard needs agent-bundle resolvable from ${project.root} (\`pnpm install\` in the checkout). In an MCP host, call hauler_status instead — the dashboard App is attached to its result.\n`,
    );
    return Promise.resolve(1);
  }
  const serveArgv = [
    cli,
    'serve-app',
    'hauler/dashboard',
    '--root',
    project.root,
    '--artifact',
    project.artifact,
    '--target',
    argv.target,
    '--tool',
    'hauler_status',
    '--allow',
    'call-tool',
    argv.open ? '--open' : '--no-open',
    ...(argv.port === undefined ? [] : ['--port', String(argv.port)]),
  ];
  return forwardToProcess(serveArgv, options);
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
    case 'dashboard':
      return runDashboard(rest, options);
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
export const main = async (argv: readonly string[], context: ExecutableMainContext): Promise<number> => {
  warnRemovedLegacyStateDir(argv);
  return runScript(argv, { terminal: context.terminal });
};
