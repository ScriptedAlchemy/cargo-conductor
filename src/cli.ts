import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';

import { runRscCli } from '@agent-bundle/rsc-runtime/plugin';
import * as Cause from 'effect/Cause';
import * as Effect from 'effect/Effect';

import { createHaulerApplication, type HaulerOperations } from './application.js';
import { buildRelevantEnv } from './client/env.js';
import { runExecClient, type RunExecOptions, type RunExecResult } from './client/exec.js';
import { ExecUsageError, parseExecArgv } from './client/parse.js';
import { resolveHaulerArgv } from './hooks/paths.js';
import {
  defaultShimDir,
  installCargoShim,
  shimPathStatus,
  type ShimPathStatus,
} from './shim/install.js';

export type { HaulerOperations };

const usage = `Usage: hauler <command>

Commands:
  exec [--session ID] [--host HOST] [--cwd DIR] [--bg] -- <cargo command>
      Run cargo through the hauler daemon
  status [--limit N]            Show queue and in-flight cargo work
  log [--limit N]               Show recent hauler requests
  last                          Show the most recent request
  await <ticket> [--max-wait-ms N]
  result <ticket>
  request [--session ID] -- <cargo command>
  daemon <run|start|stop|status>
      Control the hauler daemon
  install-shim                  Install an optional PATH cargo shim
`;

export interface CliOptions {
  readonly operations?: HaulerOperations;
  readonly runExec?: (options: RunExecOptions) => Effect.Effect<RunExecResult>;
  readonly signal?: AbortSignal;
  readonly write?: (value: string) => void;
  readonly writeStderr?: (data: string | Uint8Array) => void;
  readonly writeStdout?: (data: Uint8Array) => void;
}

const defaultWrite = (value: string): void => {
  process.stdout.write(value);
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

const defaultWriteStdout = (data: Uint8Array): void => {
  process.stdout.write(data);
};

const defaultWriteStderr = (data: string | Uint8Array): void => {
  process.stderr.write(data);
};

const runExecCommand = async (argv: readonly string[], options: CliOptions): Promise<number> => {
  const write = options.write ?? defaultWrite;
  try {
    const parsed = parseExecArgv(argv);
    const io = {
      writeStderr: options.writeStderr ?? defaultWriteStderr,
      writeStdout: options.writeStdout ?? defaultWriteStdout,
    };
    const exec = options.runExec ?? runExecClient;
    return await Effect.runPromise(
      exec({
        argv: parsed.cargoArgv,
        cwd: parsed.cwd ?? process.cwd(),
        env: buildRelevantEnv(process.env),
        host: parsed.host ?? process.env['CARGO_HAULER_HOST'] ?? 'cli',
        io,
        ...(parsed.background ? { background: true } : {}),
        ...((parsed.session ?? process.env['CARGO_HAULER_SESSION']) === undefined
          ? {}
          : { session: parsed.session ?? process.env['CARGO_HAULER_SESSION'] }),
      }).pipe(
        Effect.map((result) => result.exitCode),
        Effect.catchCause((cause) =>
          Effect.sync(() => io.writeStderr(`${Cause.pretty(cause)}\n`)).pipe(Effect.as(1)),
        ),
      ),
      { signal: options.signal },
    );
  } catch (error) {
    if (error instanceof ExecUsageError) {
      write(usage);
      return 2;
    }
    throw error;
  }
};

export const runCli = async (
  argv: readonly string[],
  options: CliOptions = {},
): Promise<number> => {
  const write = options.write ?? defaultWrite;
  const [command, ...rest] = argv;
  if (command === undefined) {
    write(usage);
    return 2;
  }
  if (command === '--help' || command === '-h') {
    write(usage);
    return 0;
  }
  if (command === 'exec') {
    return runExecCommand(rest, options);
  }
  if (command === 'install-shim') {
    const destIndex = rest.indexOf('--dir');
    const destDir = destIndex === -1 ? defaultShimDir() : rest[destIndex + 1];
    const force = rest.includes('--force');
    const realCargoIndex = rest.indexOf('--real-cargo');
    const realCargo = realCargoIndex === -1 ? 'cargo' : rest[realCargoIndex + 1];
    if (destDir === undefined || realCargo === undefined) {
      write('Usage: hauler install-shim [--dir DIR] [--real-cargo PATH] [--force]\n');
      return 2;
    }
    try {
      const installed = installCargoShim({
        haulerArgv: selfHaulerArgv(),
        destDir,
        force,
        realCargo,
      });
      write(`Installed cargo shim at ${installed.path}\n`);
      write(`${describeShimPathStatus(shimPathStatus(installed.path), destDir)}\n`);
      return 0;
    } catch (error) {
      write(`${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
  }
  try {
    return await runRscCli(
      createHaulerApplication({
        ...(options.operations === undefined ? {} : { operations: options.operations }),
      }),
      argv,
      {
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        write,
      },
    );
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Unknown command:')) {
      write(usage);
      return 2;
    }
    throw error;
  }
};

/**
 * `agent-bundle build` detects the `main` export and generates the process
 * envelope. The same module is the package bin (`src/cli.ts` convention →
 * `dist/bin/cargo-hauler.js`) and the `hauler` artifact script.
 */
export const main = async (argv: readonly string[]): Promise<number> => runCli(argv);
