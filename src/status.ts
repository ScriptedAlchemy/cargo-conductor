/** Shared scaffold status used by the CLI, MCP server, and tests. */

export const conductorStateRoot = '/fast/cache/cargo-conductor';

export interface ConductorStatus {
  readonly daemon: 'stopped';
  readonly stateRoot: string;
  readonly summary: string;
}

export const reportConductorStatus = (): ConductorStatus => ({
  daemon: 'stopped',
  stateRoot: conductorStateRoot,
  summary: 'cargo-conductor daemon is not running (scaffold).',
});
