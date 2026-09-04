/** The profile cargo builds with when the argv names none. */
export const defaultCargoProfile = (subcommand: string): string => {
  if (subcommand === 'test') {
    return 'test';
  }
  if (subcommand === 'bench') {
    return 'bench';
  }
  if (subcommand === 'install') {
    return 'release';
  }
  return 'dev';
};

export const cargoJsonDemuxFlag = '--message-format=json-diagnostic-rendered-ansi';

export const optionParts = (
  argument: string,
): readonly [option: string, inlineValue: string | undefined] => {
  const equalsIndex = argument.indexOf('=');
  return equalsIndex === -1
    ? [argument, undefined]
    : [argument.slice(0, equalsIndex), argument.slice(equalsIndex + 1)];
};

export const namedPackagesInArgv = (argv: readonly string[]): Set<string> => {
  const named = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const part = argv[index];
    if (part === '-p' || part === '--package') {
      const name = argv[index + 1];
      if (name !== undefined) {
        named.add(name);
      }
      continue;
    }
    if (part !== undefined && part.startsWith('--package=')) {
      named.add(part.slice('--package='.length));
    }
  }
  return named;
};
