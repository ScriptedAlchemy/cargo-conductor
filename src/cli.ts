import { reportConductorStatus } from './status.js';

const usage = `Usage: conductor <command>

Commands:
  exec -- <cargo command>   Run cargo through the conductor daemon
  status                    Show queue and in-flight cargo work
  log                       Show recent conductor requests
  last                      Show the most recent request
  daemon start|stop         Control the conductor daemon
  install-shim              Install an optional PATH cargo shim
`;

const commands = ['daemon', 'exec', 'install-shim', 'last', 'log', 'status'] as const;
type Command = (typeof commands)[number];

const isCommand = (value: string): value is Command =>
  (commands as readonly string[]).includes(value);

/** Injectable writer so tests can capture output without a child process. */
export const runCli = (
  argv: readonly string[],
  write: (line: string) => void = (line) => {
    process.stdout.write(line);
  },
): 0 | 1 | 2 => {
  const [rawCommand] = argv;
  if (rawCommand === undefined || rawCommand === '--help' || rawCommand === '-h') {
    write(usage);
    return rawCommand === undefined ? 2 : 0;
  }
  if (!isCommand(rawCommand)) {
    write(usage);
    return 2;
  }
  switch (rawCommand) {
    case 'last':
    case 'log':
    case 'status': {
      const status = reportConductorStatus();
      write(`${status.summary}\n`);
      return 0;
    }
    case 'daemon':
    case 'exec':
    case 'install-shim':
      write('cargo-conductor: not implemented in the scaffold.\n');
      return 1;
    default: {
      const exhaustive: never = rawCommand;
      throw new Error(`Unhandled command: ${String(exhaustive)}`);
    }
  }
};

/**
 * `agent-bundle build` detects the `main` export and generates the process
 * envelope. The same module is the package bin (`src/cli.ts` convention →
 * `dist/bin/cargo-conductor.js`) and the `conductor` artifact script.
 */
export const main = async (argv: readonly string[]): Promise<number> => runCli(argv);
