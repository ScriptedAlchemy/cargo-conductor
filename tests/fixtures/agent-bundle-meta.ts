import { readFileSync } from 'node:fs';

import type { AgentBundleMeta } from 'agent-bundle/meta';

/**
 * Test-time stand-in for `agent-bundle/meta`. The real subpath throws at
 * import outside a compiled surface, so plain rstest suites that import source
 * modules such as `src/daemon/main.ts` would fail at module evaluation. The
 * rstest config aliases the specifier here; compiled artifacts never see it.
 */
const packageJson = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as { readonly name: string; readonly version: string };

export const meta: AgentBundleMeta = {
  name: 'cargo-hauler',
  packageName: packageJson.name,
  packageVersion: packageJson.version,
  version: packageJson.version,
};

export const name: AgentBundleMeta['name'] = meta.name;
export const packageName: AgentBundleMeta['packageName'] = meta.packageName;
export const packageVersion: AgentBundleMeta['packageVersion'] = meta.packageVersion;
export const version: AgentBundleMeta['version'] = meta.version;
