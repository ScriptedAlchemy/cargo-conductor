import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'effect-rstest';

const packageJson = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { readonly version: string };
const cursorPluginJson = JSON.parse(
  readFileSync(
    new URL('../artifact/cursor/.cursor-plugin/plugin.json', import.meta.url),
    'utf8',
  ),
) as { readonly version: string };

describe('version consistency', () => {
  it('stamps the package version into the generated plugin manifest', () => {
    expect(cursorPluginJson.version).toBe(packageJson.version);
  });
});
