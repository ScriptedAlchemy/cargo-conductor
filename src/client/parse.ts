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
  /** Tickets named by `--after` (repeatable or comma-separated), deduplicated in order. */
  readonly after?: readonly string[];
}

const valuedFlags = ['--cwd', '--host', '--session', '--after'] as const;
type ValuedFlag = (typeof valuedFlags)[number];

const isValuedFlag = (argument: string): argument is ValuedFlag =>
  valuedFlags.some((flag) => flag === argument);

const takeValue = (argv: readonly string[], index: number, option: ValuedFlag): string => {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('-')) {
    throw new ExecUsageError(`${option} requires a value`);
  }
  return value;
};

/**
 * Splits `--after` values (`cc-1,cc-2`, or one ticket per repeated flag) into
 * a deduplicated ticket list; the daemon validates that each one exists.
 */
export const parseTicketList = (values: readonly string[]): readonly string[] => [
  ...new Set(
    values.flatMap((value) => value.split(',')).map((part) => part.trim()).filter((part) => part.length > 0),
  ),
];

/**
 * Flags before `--` (or before the cargo argv) belong to hauler.
 * Everything after `--`, or the remaining tokens, is the cargo command.
 */
export const parseExecArgv = (argv: readonly string[]): ParsedExecArgv => {
  let background = false;
  let cwd: string | undefined;
  let host: string | undefined;
  let session: string | undefined;
  const afterValues: string[] = [];
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
    if (isValuedFlag(argument)) {
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
        case '--after':
          if (parseTicketList([value]).length === 0) {
            throw new ExecUsageError('--after requires a value');
          }
          afterValues.push(value);
          break;
        default: {
          const exhaustive: never = argument;
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

  const after = parseTicketList(afterValues);
  return {
    background,
    cargoArgv,
    ...(cwd === undefined ? {} : { cwd }),
    ...(host === undefined ? {} : { host }),
    ...(session === undefined ? {} : { session }),
    ...(after.length === 0 ? {} : { after }),
  };
};
