import { Lexer, T, parse, print } from 'bashjsast';
import type { BashSimpleCommand, BashWord } from 'bashjsast';

import { parseCargoArgv } from '../daemon/intent-normalizer.js';

import { isRecord } from './shared.js';

const cargoExecutable = /(?:^|[/\\])cargo(?:\.exe)?$/u;
const haulerExecutable = /(?:^|[/\\])(?:cargo-hauler|hauler)(?:\.mjs)?$/u;
const prefixCommands = new Set([
  // `!` lexes as a plain word after `while`/`until`/`if`, so a negated test
  // arrives as the command name rather than a negated pipeline.
  '!',
  'builtin',
  'command',
  'env',
  'exec',
  'ionice',
  'nice',
  'nohup',
  'rustup',
  'stdbuf',
  'strace',
  'sudo',
  'time',
  'timeout',
  'xargs',
]);
const prefixValueFlags: Readonly<Record<string, ReadonlySet<string>>> = {
  env: new Set(['--chdir', '--split-string', '--unset', '-C', '-S', '-u']),
  exec: new Set(['-a']),
  ionice: new Set(['-c', '-n', '-p', '-t']),
  nice: new Set(['--adjustment', '-n']),
  stdbuf: new Set(['--error', '--input', '--output', '-e', '-i', '-o']),
  timeout: new Set(['--kill-after', '--signal', '-k', '-s']),
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
/** Positional operands a prefix consumes before the wrapped command (`timeout 600 cargo …`). */
const prefixPositionals: Readonly<Record<string, number>> = {
  timeout: 1,
};
const isAssignment = (token: string | undefined): token is string =>
  token !== undefined && /^[A-Za-z_][A-Za-z0-9_]*=/u.test(token);
/** `command -v cargo` / `command -V cargo` print a path or description; they never run cargo. */
const commandLookupFlag = /^-[A-Za-z]*[vV]/u;

/**
 * No `cwd` here on purpose: the rewritten command runs in the same shell as
 * the original, so `hauler exec` inherits the working directory through
 * `process.cwd()`. Passing the hook envelope's cwd would override an
 * in-command `cd crates/foo && cargo build`.
 */
export interface RewriteOptions {
  readonly haulerArgv: readonly string[];
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
    if (base === 'rustup') {
      // Only `rustup run [flags] <toolchain> [--] cargo …` wraps a cargo
      // command; every other rustup subcommand is rustup's own business.
      if (argv[index] !== 'run') {
        return -1;
      }
      index += 1;
      index = skipOptionEnd(argv, skipFlags(argv, index)) + 1;
      index = skipOptionEnd(argv, index);
      continue;
    }
    const valueFlags = prefixValueFlags[base];
    // `env` accepts VAR=value operands before, between, and after its flags.
    while (index < argv.length) {
      const token = argv[index];
      if (token === undefined) {
        break;
      }
      if (base === 'env' && isAssignment(token)) {
        index += 1;
        continue;
      }
      if (token === '--') {
        index += 1;
        break;
      }
      if (!token.startsWith('-')) {
        break;
      }
      if (base === 'command' && commandLookupFlag.test(token)) {
        return -1;
      }
      index += 1;
      if (token.includes('=')) {
        continue;
      }
      const next = argv[index];
      if (valueFlags?.has(token) === true && next !== undefined && !next.startsWith('-')) {
        index += 1;
      }
    }
    index += prefixPositionals[base] ?? 0;
  }
  return -1;
};

const skipFlags = (argv: readonly string[], start: number): number => {
  let index = start;
  while (index < argv.length && argv[index]?.startsWith('-') === true && argv[index] !== '--') {
    index += 1;
  }
  return index;
};

const skipOptionEnd = (argv: readonly string[], index: number): number =>
  argv[index] === '--' ? index + 1 : index;

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

const wrapWords = (words: readonly BashWord[], cargoIndex: number, options: RewriteOptions): BashWord[] => [
  ...words.slice(0, cargoIndex),
  ...options.haulerArgv.map(asWord),
  asWord('exec'),
  asWord('--session'),
  asWord(options.session),
  asWord('--host'),
  asWord(options.host),
  asWord('--'),
  ...words.slice(cargoIndex),
];

/**
 * Tokens the round-trip comparison treats as one statement separator: the
 * printer emits `;\n` where the source had `;` or a newline.
 */
const separatorTypes = new Set<string>([T.NEWLINE, T.SEMI]);
/**
 * Reserved words and grouping tokens the printer pads with newlines (`then\n`,
 * `do\n`, `{ \n`, `\nfi`). Separators next to them carry no meaning: the lexer
 * only produces these token types in command position, so a missing separator
 * would already show up as a different token type.
 */
const structuralTypes = new Set<string>([
  T.CASE,
  T.COPROC,
  T.DO,
  T.DONE,
  T.ELIF,
  T.ELSE,
  T.ESAC,
  T.FI,
  T.FOR,
  T.FUNCTION,
  T.IF,
  T.IN,
  T.LBRACE,
  T.LPAREN,
  T.RBRACE,
  T.RPAREN,
  T.SELECT,
  T.SEMI_AND,
  T.SEMI_SEMI,
  T.SEMI_SEMI_AND,
  T.THEN,
  T.UNTIL,
  T.WHILE,
]);
const separatorMarker = ';';

const normalizedTokens = (source: string): readonly string[] | null => {
  let tokens: readonly { readonly type: string; readonly value: string }[];
  try {
    tokens = new Lexer(source).tokenize();
  } catch {
    return null;
  }
  const normalized: string[] = [];
  let lastStructural = true;
  for (const token of tokens) {
    if (token.type === T.EOF) {
      break;
    }
    if (separatorTypes.has(token.type)) {
      if (!lastStructural && normalized[normalized.length - 1] !== separatorMarker) {
        normalized.push(separatorMarker);
      }
      continue;
    }
    const structural = structuralTypes.has(token.type);
    if (structural && normalized[normalized.length - 1] === separatorMarker) {
      normalized.pop();
    }
    normalized.push(`${token.type}:${token.value}`);
    lastStructural = structural;
  }
  if (normalized[normalized.length - 1] === separatorMarker) {
    normalized.pop();
  }
  return normalized;
};

/**
 * The pinned bashjsast parser discards `&` (background jobs), the `time`
 * keyword, and `|&`, and its printer places heredoc bodies immediately after
 * their command, which breaks any heredoc that is not the final statement.
 * Rather than enumerate those cases, require that printing the untouched AST
 * reproduces the original token stream (modulo separators and whitespace);
 * anything else is a construct the rewrite cannot express, so the command is
 * left alone.
 */
const roundTrips = (command: string, printedUnchanged: string): boolean => {
  const before = normalizedTokens(command);
  const after = normalizedTokens(printedUnchanged);
  if (before === null || after === null || before.length !== after.length) {
    return false;
  }
  return before.every((token, index) => token === after[index]);
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

export interface PreparedShellCommand {
  readonly inspection: InspectedCommand;
  /** The rewritten command, or the original when nothing changed or the AST cannot round-trip. */
  readonly rewrite: (options: RewriteOptions) => string;
}

/**
 * Parse once for the beforeTool hook, deferring mutation until it elects to
 * rewrite. `alreadyWrapped` reports that at least one invocation is already
 * brokered; `hasCargo` reports that at least one is not, so a partially
 * wrapped list (`hauler exec -- cargo build && cargo test`) still rewrites.
 */
export const prepareShellCommand = (command: string): PreparedShellCommand => {
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
      if (!hasCargo || !roundTrips(command, print(ast))) {
        return command;
      }
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

export const inspectShellCommand = (command: string): InspectedCommand =>
  prepareShellCommand(command).inspection;

export const rewriteShellCommand = (command: string, options: RewriteOptions): string =>
  prepareShellCommand(command).rewrite(options);
