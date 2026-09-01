export class ExecUsageError extends Error {
  readonly exitCode = 2 as const;

  constructor(message: string) {
    super(message);
    this.name = 'ExecUsageError';
  }
}

export interface ParsedExecArgv {
  readonly background: boolean;
  readonly cargoArgv: readonly string[];
  readonly cwd?: string;
  readonly host?: string;
  readonly session?: string;
}

const valuedFlags = new Set(['--cwd', '--host', '--session']);

const takeValue = (argv: readonly string[], index: number, option: string): string => {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('-')) {
    throw new ExecUsageError(`${option} requires a value`);
  }
  return value;
};

/**
 * Flags before `--` (or before the cargo argv) belong to conductor.
 * Everything after `--`, or the remaining tokens, is the cargo command.
 */
export const parseExecArgv = (argv: readonly string[]): ParsedExecArgv => {
  let background = false;
  let cwd: string | undefined;
  let host: string | undefined;
  let session: string | undefined;
  const cargoArgv: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--') {
      cargoArgv.push(...argv.slice(index + 1));
      break;
    }
    if (argument === '--bg') {
      background = true;
      continue;
    }
    if (valuedFlags.has(argument)) {
      const value = takeValue(argv, index, argument);
      index += 1;
      switch (argument) {
        case '--cwd':
          cwd = value;
          break;
        case '--host':
          host = value;
          break;
        case '--session':
          session = value;
          break;
        default: {
          const exhaustive: never = argument as never;
          throw new ExecUsageError(`Unhandled option: ${String(exhaustive)}`);
        }
      }
      continue;
    }
    if (argument.startsWith('-')) {
      throw new ExecUsageError(`Unknown option: ${argument}`);
    }
    cargoArgv.push(...argv.slice(index));
    break;
  }

  if (cargoArgv.length === 0) {
    throw new ExecUsageError('exec requires a cargo command');
  }

  return {
    background,
    cargoArgv,
    ...(cwd === undefined ? {} : { cwd }),
    ...(host === undefined ? {} : { host }),
    ...(session === undefined ? {} : { session }),
  };
};
