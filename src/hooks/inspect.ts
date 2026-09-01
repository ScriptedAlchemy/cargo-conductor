import { parse, print } from 'bashjsast';
import type { BashSimpleCommand, BashWord } from 'bashjsast';

import { parseCargoArgv } from '../daemon/intent-normalizer.js';

import { isRecord } from './shared.js';

const cargoExecutable = /(?:^|[/\\])cargo(?:\.exe)?$/u;
const haulerExecutable = /(?:^|[/\\])(?:cargo-hauler|hauler)(?:\.mjs)?$/u;
const prefixCommands = new Set([
  'builtin',
  'command',
  'env',
  'exec',
  'ionice',
  'nice',
  'nohup',
  'strace',
  'sudo',
  'time',
  'xargs',
]);
const prefixValueFlags: Readonly<Record<string, ReadonlySet<string>>> = {
  env: new Set(['--chdir', '--split-string', '--unset', '-C', '-S', '-u']),
  exec: new Set(['-a']),
  ionice: new Set(['-c', '-n', '-p', '-t']),
  nice: new Set(['--adjustment', '-n']),
  sudo: new Set([
    '--close-from',
    '--command-timeout',
    '--group',
    '--prompt',
    '--role',
    '--type',
    '--user',
    '-C',
    '-g',
    '-p',
    '-r',
    '-t',
    '-T',
    '-u',
  ]),
  time: new Set(['-f', '-o']),
  xargs: new Set(['-E', '-I', '-J', '-L', '-n', '-P', '-s']),
};

export interface RewriteOptions {
  readonly haulerArgv: readonly string[];
  readonly cwd?: string;
  readonly host: string;
  readonly session: string;
}

export interface InspectedCommand {
  readonly alreadyWrapped: boolean;
  readonly destructive: boolean;
  readonly hasCargo: boolean;
}

const asWord = (text: string): BashWord => ({
  text: text.length === 0 || /[\s'"$`\\|&;()<>]/.test(text) ? shellQuote(text) : text,
  type: 'Word',
});

const shellQuote = (text: string): string => `'${text.replaceAll("'", `'\\''`)}'`;

const commandWords = (command: BashSimpleCommand): BashWord[] => {
  const words: BashWord[] = [];
  if (command.name !== undefined) {
    words.push(command.name);
  }
  words.push(...(command.args ?? []));
  return words;
};

const findCargoIndex = (argv: readonly string[]): number => {
  let index = 0;
  while (index < argv.length) {
    const token = argv[index];
    if (token === undefined) {
      return -1;
    }
    if (cargoExecutable.test(token)) {
      return index;
    }
    const base = token.slice(Math.max(token.lastIndexOf('/'), token.lastIndexOf('\\')) + 1);
    if (!prefixCommands.has(base)) {
      return -1;
    }
    index += 1;
    if (base === 'env') {
      while (index < argv.length && argv[index] !== undefined && /^[A-Za-z_][A-Za-z0-9_]*=/u.test(argv[index])) {
        index += 1;
      }
    }
    const valueFlags = prefixValueFlags[base];
    while (index < argv.length && argv[index]?.startsWith('-') === true) {
      const flag = argv[index];
      index += 1;
      if (flag === undefined || flag.includes('=')) {
        continue;
      }
      const next = argv[index];
      if (valueFlags?.has(flag) === true && next !== undefined && !next.startsWith('-')) {
        index += 1;
      }
    }
  }
  return -1;
};

const isAlreadyWrapped = (argv: readonly string[]): boolean => {
  const haulerIndex = argv.findIndex((token) => haulerExecutable.test(token));
  if (haulerIndex === -1) {
    return false;
  }
  const after = argv.slice(haulerIndex + 1);
  return after.includes('exec') && after.includes('--');
};

const isDestructiveArgv = (cargoArgv: readonly string[]): boolean => {
  try {
    return parseCargoArgv(cargoArgv).subcommand === 'clean';
  } catch {
    return false;
  }
};

const isSimpleCommand = (
  node: Record<string, unknown>,
): node is Record<string, unknown> & BashSimpleCommand => node.type === 'SimpleCommand';

const walkSimpleCommands = (node: unknown, visit: (command: BashSimpleCommand) => void): void => {
  if (!isRecord(node) || typeof node.type !== 'string') {
    return;
  }
  if (isSimpleCommand(node)) {
    visit(node);
    return;
  }
  switch (node.type) {
    case 'Script':
    case 'Pipeline':
      for (const child of Array.isArray(node.commands) ? node.commands : []) {
        walkSimpleCommands(child, visit);
      }
      return;
    case 'List':
      walkSimpleCommands(node.left, visit);
      walkSimpleCommands(node.right, visit);
      return;
    case 'If':
      walkSimpleCommands(node.test, visit);
      walkSimpleCommands(node.body, visit);
      walkSimpleCommands(node.alternate, visit);
      return;
    case 'While':
    case 'Until':
      walkSimpleCommands(node.test, visit);
      walkSimpleCommands(node.body, visit);
      return;
    case 'For':
    case 'Select':
    case 'Group':
    case 'Subshell':
    case 'Function':
    case 'Coproc':
      walkSimpleCommands(node.body, visit);
      return;
    case 'Case':
      for (const clause of Array.isArray(node.clauses) ? node.clauses : []) {
        walkSimpleCommands(isRecord(clause) ? clause.body : undefined, visit);
      }
      return;
    default:
      return;
  }
};

const wrapWords = (words: readonly BashWord[], cargoIndex: number, options: RewriteOptions): BashWord[] => {
  const inserted: BashWord[] = [
    ...options.haulerArgv.map(asWord),
    asWord('exec'),
    asWord('--session'),
    asWord(options.session),
    asWord('--host'),
    asWord(options.host),
  ];
  if (options.cwd !== undefined && options.cwd.length > 0) {
    inserted.push(asWord('--cwd'), asWord(options.cwd));
  }
  inserted.push(asWord('--'), ...words.slice(cargoIndex));
  return [...words.slice(0, cargoIndex), ...inserted];
};

const rewriteSimpleCommand = (command: BashSimpleCommand, options: RewriteOptions): boolean => {
  const words = commandWords(command);
  const argv = words.map((word) => word.text);
  if (argv.length === 0 || isAlreadyWrapped(argv)) {
    return false;
  }
  const cargoIndex = findCargoIndex(argv);
  if (cargoIndex === -1) {
    return false;
  }
  const wrapped = wrapWords(words, cargoIndex, options);
  const [name, ...args] = wrapped;
  if (name === undefined) {
    return false;
  }
  command.name = name;
  command.args = args;
  return true;
};

export const inspectShellCommand = (command: string): InspectedCommand => {
  const ast = parse(command);
  let alreadyWrapped = false;
  let destructive = false;
  let hasCargo = false;
  walkSimpleCommands(ast, (simple) => {
    const argv = commandWords(simple).map((word) => word.text);
    if (isAlreadyWrapped(argv)) {
      alreadyWrapped = true;
      return;
    }
    const cargoIndex = findCargoIndex(argv);
    if (cargoIndex === -1) {
      return;
    }
    hasCargo = true;
    if (isDestructiveArgv(argv.slice(cargoIndex))) {
      destructive = true;
    }
  });
  return { alreadyWrapped, destructive, hasCargo };
};

export const rewriteShellCommand = (command: string, options: RewriteOptions): string => {
  const ast = parse(command);
  let changed = false;
  walkSimpleCommands(ast, (simple) => {
    if (rewriteSimpleCommand(simple, options)) {
      changed = true;
    }
  });
  return changed ? print(ast) : command;
};

/** Parse once for the beforeTool hook, deferring mutation until it elects to rewrite. */
export const prepareShellCommand = (
  command: string,
): { readonly inspection: InspectedCommand; readonly rewrite: (options: RewriteOptions) => string } => {
  const ast = parse(command);
  let alreadyWrapped = false;
  let destructive = false;
  let hasCargo = false;
  walkSimpleCommands(ast, (simple) => {
    const argv = commandWords(simple).map((word) => word.text);
    if (isAlreadyWrapped(argv)) {
      alreadyWrapped = true;
      return;
    }
    const cargoIndex = findCargoIndex(argv);
    if (cargoIndex === -1) {
      return;
    }
    hasCargo = true;
    if (isDestructiveArgv(argv.slice(cargoIndex))) {
      destructive = true;
    }
  });
  return {
    inspection: { alreadyWrapped, destructive, hasCargo },
    rewrite: (options) => {
      let changed = false;
      walkSimpleCommands(ast, (simple) => {
        if (rewriteSimpleCommand(simple, options)) {
          changed = true;
        }
      });
      return changed ? print(ast) : command;
    },
  };
};
