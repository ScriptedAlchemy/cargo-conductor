import type { AgentRequestContext } from '@agent-bundle/runtime';

import { resolveDaemonConfig, type DaemonConfigShape } from '../daemon/config.js';

import { isRecord } from './guards.js';

const isDaemonConfig = (value: unknown): value is DaemonConfigShape =>
  isRecord(value) &&
  typeof value.stateDir === 'string' &&
  typeof value.socketPath === 'string' &&
  typeof value.databasePath === 'string';

/**
 * The daemon config for this request: the `daemonConfig` provider when the
 * request scope mounted one, otherwise resolved from the environment (the
 * same answer a script or hook wrapper gets).
 */
export const requestDaemonConfig = (
  context: Pick<AgentRequestContext, 'providers'>,
): DaemonConfigShape => {
  const provided = context.providers.daemonConfig;
  return isDaemonConfig(provided) ? provided : resolveDaemonConfig();
};
