import { join } from 'node:path';

import { conductorStateRoot } from '../status.js';

/** Absolute `node …/conductor.mjs` when the plugin root is known; otherwise PATH `conductor`. */
export const resolveConductorArgv = (
  env: Readonly<Record<string, string | undefined>> = process.env,
): readonly string[] => {
  const pluginRoot =
    env.AGENT_BUNDLE_PLUGIN_ROOT ??
    env.CLAUDE_PLUGIN_ROOT ??
    env.CURSOR_PLUGIN_ROOT ??
    env.PLUGIN_ROOT;
  if (pluginRoot !== undefined && pluginRoot.length > 0) {
    return [process.execPath, join(pluginRoot, 'scripts/conductor.mjs')];
  }
  return ['conductor'];
};

export const resolveHookStateDir = (
  env: Readonly<Record<string, string | undefined>> = process.env,
): string => env.CARGO_CONDUCTOR_STATE_DIR ?? conductorStateRoot;

export const resolveHookSocketPath = (
  env: Readonly<Record<string, string | undefined>> = process.env,
): string => join(resolveHookStateDir(env), 'daemon.sock');
