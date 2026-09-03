import { join } from 'node:path';

import { daemonSocketPath, resolveStateDir } from '../status.js';

/** Absolute `node …/hauler.mjs` when the plugin root is known; otherwise PATH `hauler`. */
export const resolveHaulerArgv = (
  env: Readonly<Record<string, string | undefined>> = process.env,
): readonly string[] => {
  const pluginRoot =
    env.AGENT_BUNDLE_PLUGIN_ROOT ??
    env.CLAUDE_PLUGIN_ROOT ??
    env.CURSOR_PLUGIN_ROOT ??
    env.PLUGIN_ROOT;
  if (pluginRoot !== undefined && pluginRoot.length > 0) {
    return [process.execPath, join(pluginRoot, 'scripts/hauler.mjs')];
  }
  return ['hauler'];
};

export const resolveHookStateDir = (
  env: Readonly<Record<string, string | undefined>> = process.env,
): string => resolveStateDir(env);

export const resolveHookSocketPath = (
  env: Readonly<Record<string, string | undefined>> = process.env,
  platform: NodeJS.Platform = process.platform,
): string => daemonSocketPath(resolveHookStateDir(env), platform, env);
