import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';

import { runRscCli } from '@agent-bundle/rsc-runtime/plugin';
import * as Cause from 'effect/Cause';
import * as Effect from 'effect/Effect';

import { createConductorApplication, type ConductorOperations } from './application.js';
import { buildRelevantEnv } from './client/env.js';
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

/**
 * The shim must never depend on a PATH `conductor` that nothing installs
 * (issue #2): embed the absolute node + script that is running right now.
 */
const selfConductorArgv = (): readonly string[] => {
  const script = process.argv[1];
  if (script === undefined || script.length === 0) {
    return resolveConductorArgv();
  }
  let absolute = resolve(script);
  try {
    absolute = realpathSync(absolute);
  } catch {
    // Keep the resolved path when realpath cannot refine it.
  }
  return [process.execPath, absolute];
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
        io,
        ...(parsed.background ? { background: true } : {}),
        ...(parsed.host === undefined ? {} : { host: parsed.host }),
        ...(parsed.session === undefined ? {} : { session: parsed.session }),
      }).pipe(
        Effect.map((result) => result.exitCode),
        Effect.catchAllCause((cause) =>
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
      write('Usage: conductor install-shim [--dir DIR] [--real-cargo PATH] [--force]\n');
      return 2;
    }
    try {
      const installed = installCargoShim({
        conductorArgv: selfConductorArgv(),
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
