import type { AgentRequestContext } from '@agent-bundle/runtime';

import { resolveDaemonConfig, type DaemonConfigShape } from '../daemon/config.js';
import type { HaulerDaemonContext } from '../providers/hauler-daemon.js';

import { isRecord } from './guards.js';

const isDaemonConfig = (value: unknown): value is DaemonConfigShape =>
  isRecord(value) &&
  typeof value.stateDir === 'string' &&
  typeof value.socketPath === 'string' &&
  typeof value.databasePath === 'string';

const isHaulerDaemonContext = (value: unknown): value is HaulerDaemonContext =>
  isRecord(value) && isDaemonConfig(value.config) && isRecord(value.health) && typeof value.health.state === 'string';

/**
 * The daemon connection for this request: the `haulerDaemon` provider when
 * the request scope mounted one, otherwise `undefined` (a scope with an
 * explicit empty provider map, such as a degraded-path test).
 */
export const requestDaemon = (
  context: Pick<AgentRequestContext, 'providers'>,
): HaulerDaemonContext | undefined => {
  const provided: unknown = context.providers.haulerDaemon;
  return isHaulerDaemonContext(provided) ? provided : undefined;
};

/**
 * The daemon config for this request: the provider's when mounted, otherwise
 * resolved from the environment (the same answer a script or hook wrapper
 * gets).
 */
export const requestDaemonConfig = (
  context: Pick<AgentRequestContext, 'providers'>,
): DaemonConfigShape => requestDaemon(context)?.config ?? resolveDaemonConfig();
