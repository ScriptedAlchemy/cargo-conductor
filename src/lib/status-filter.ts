import type { RequestRecord } from '../daemon/protocol.js';
import { commandDisplay } from './format.js';

import type { StatusInput, DaemonStatus } from './protocol-schemas.js';

export const hasStatusFilters = (input: StatusInput): boolean =>
  input.cwd !== undefined ||
  input.session !== undefined ||
  input.laneKey !== undefined ||
  input.tickets !== undefined ||
  input.statuses !== undefined ||
  input.commandContains !== undefined;

export const filterStatusRows = (
  rows: readonly RequestRecord[],
  input: StatusInput,
): readonly RequestRecord[] => {
  const tickets = input.tickets === undefined ? null : new Set(input.tickets);
  const statuses = input.statuses === undefined ? null : new Set(input.statuses);
  return rows.filter(
    (row) =>
      (input.cwd === undefined || row.cwd === input.cwd) &&
      (input.session === undefined || row.session === input.session) &&
      (input.laneKey === undefined || row.laneKey === input.laneKey) &&
      (tickets === null || tickets.has(row.ticket)) &&
      (statuses === null || statuses.has(row.status)) &&
      (input.commandContains === undefined ||
        row.argv.join(' ').includes(input.commandContains)),
  );
};

const daemonHeader = (daemon: DaemonStatus): string => {
  switch (daemon) {
    case 'running':
      return 'cargo-hauler daemon is running';
    case 'stopped':
      return 'cargo-hauler daemon is not running';
    case 'unresponsive':
      return 'cargo-hauler daemon is up but did not answer in time (showing ledger data)';
    default: {
      const exhaustive: never = daemon;
      return exhaustive;
    }
  }
};

export const statusSummary = (
  daemon: DaemonStatus,
  active: readonly RequestRecord[],
  recent: readonly RequestRecord[],
): string => {
  const commandLimit = 160;
  const header = `${daemonHeader(daemon)}; ${active.length} active, ${recent.length} recent`;
  if (active.length === 0) {
    return header;
  }
  return [
    header,
    ...active.map((row) => {
      const fullCommand = commandDisplay(row.argv);
      const command =
        fullCommand.length <= commandLimit
          ? fullCommand
          : `${fullCommand.slice(0, commandLimit - 1)}…`;
      const location = row.session ?? row.cwd;
      return `${row.ticket} ${row.status} ${command} (${location})`;
    }),
  ].join('\n');
};
