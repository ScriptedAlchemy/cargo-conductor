/**
 * The same document renders on two surfaces whose follow-up commands are
 * spelled differently: MCP tool names for hosts, `hauler <cmd>` for the CLI.
 */
export interface SurfaceNames {
  readonly await: string;
  readonly kill: string;
  readonly log: string;
  readonly request: string;
  readonly result: string;
  /** The result call that renders a ticket's whole on-disk output log. */
  readonly resultFull: (ticket: string) => string;
  readonly status: string;
}

export const mcpSurface: SurfaceNames = {
  await: 'hauler_await',
  kill: 'hauler_kill',
  log: 'hauler_log',
  request: 'hauler_request',
  result: 'hauler_result',
  resultFull: (ticket) => `hauler_result { ticket: "${ticket}", full: true }`,
  status: 'hauler_status',
};

export const cliSurface: SurfaceNames = {
  await: 'hauler await',
  kill: 'hauler kill',
  log: 'hauler log',
  request: 'hauler request',
  result: 'hauler result',
  resultFull: (ticket) => `hauler result ${ticket} --full`,
  status: 'hauler status',
};
