import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from '@rstest/core';

import { APP_RESOURCE_URI } from '../src/constants.js';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

describe('MCP App dashboard', () => {
  it('declares the widget URI and ships a self-contained artifact page', () => {
    expect(APP_RESOURCE_URI).toBe('ui://cargo-conductor/dashboard.html');
    const built = join(repoRoot, 'artifact', 'plugin', 'mcp-apps', 'dashboard.html');
    expect(existsSync(built)).toBe(true);
    const html = readFileSync(built, 'utf8');
    expect(html).toContain('In flight');
    expect(html).toContain('History');
    expect(html).toContain('Contention');
    expect(html).toContain('conductor_status');
    expect(html).not.toContain('src="http');
  });
});
