import { runRscCli } from '@agent-bundle/rsc-runtime/plugin';
import * as Effect from 'effect/Effect';

import { createConductorApplication, type ConductorOperations } from './application.js';
import { runExecClient, type RunExecOptions, type RunExecResult } from './client/exec.js';
import { ExecUsageError, parseExecArgv } from './client/parse.js';
import { resolveConductorArgv } from './hooks/paths.js';
import { defaultShimDir, installCargoShim } from './shim/install.js';

export type { ConductorOperations };

const usage = `Usage: conductor <command>

Commands:
  exec [--session ID] [--host HOST] [--cwd DIR] [--bg] -- <cargo command>
      Run cargo through the conductor daemon
  status [--limit N]            Show queue and in-flight cargo work
  log [--limit N]               Show recent conductor requests
  last                          Show the most recent request
  await <ticket> [--max-wait-ms N]
  result <ticket>
  request [--session ID] -- <cargo command>
  daemon <run|start|stop|status>
      Control the conductor daemon
  install-shim                  Install an optional PATH cargo shim
`;

export interface CliOptions {
  readonly operations?: ConductorOperations;
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

const runExecCommand = async (argv: readonly string[], options: CliOptions): Promise<number> => {
  const write = options.write ?? defaultWrite;
  try {
    const parsed = parseExecArgv(argv);
    const io = {
      writeStderr: options.writeStderr ?? defaultWriteStderr,
      writeStdout: options.writeStdout ?? defaultWriteStdout,
    };
    const exec = options.runExec ?? runExecClient;
    const result = await Effect.runPromise(
      exec({
        argv: parsed.cargoArgv,
        cwd: parsed.cwd ?? process.cwd(),
        io,
        ...(parsed.background ? { background: true } : {}),
        ...(parsed.host === undefined ? {} : { host: parsed.host }),
        ...(parsed.session === undefined ? {} : { session: parsed.session }),
      }),
    );
    return result.exitCode;
  } catch (error) {
    if (error instanceof ExecUsageError) {
      write(usage);
      return 2;
    }
    throw error;
  }
};

/**
 * Hybrid CLI: `exec` streams cargo through the Effect client (progress lines,
 * fail-open passthrough). Everything else is the RSC catalog projection
 * (`status`, `log`, `last`, `daemon`).
 */
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
    const realCargo =
      rest.includes('--real-cargo') ? rest[rest.indexOf('--real-cargo') + 1] : 'cargo';
    if (destDir === undefined || realCargo === undefined) {
      write('Usage: conductor install-shim [--dir DIR] [--real-cargo PATH] [--force]\n');
      return 2;
    }
    try {
      const installed = installCargoShim({
        conductorArgv: resolveConductorArgv(),
        destDir,
        force,
        realCargo,
      });
      write(`Installed cargo shim at ${installed.path}\nPrepend ${destDir} to PATH to catch cargo inside scripts.\n`);
      return 0;
    } catch (error) {
      write(`${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
  }
  try {
    return await runRscCli(
      createConductorApplication({
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
 * `dist/bin/cargo-conductor.js`) and the `conductor` artifact script.
 */
export const main = async (argv: readonly string[]): Promise<number> => runCli(argv);
