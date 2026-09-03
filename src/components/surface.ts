/**
 * The same document renders on two surfaces whose follow-up commands are
 * spelled differently: MCP tool names for hosts, `hauler <cmd>` for the CLI.
 */
export interface SurfaceNames {
  readonly await: string;
  readonly log: string;
  readonly request: string;
  readonly result: string;
  readonly status: string;
}

export const mcpSurface: SurfaceNames = {
  await: 'hauler_await',
  log: 'hauler_log',
  request: 'hauler_request',
  result: 'hauler_result',
  status: 'hauler_status',
};

export const cliSurface: SurfaceNames = {
  await: 'hauler await',
  log: 'hauler log',
  request: 'hauler request',
  result: 'hauler result',
  status: 'hauler status',
};
