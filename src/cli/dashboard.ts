import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { CliRouteConfig, CliRouteProps } from 'agent-bundle';
import { z } from 'zod';

/**
 * `hauler dashboard`: the MCP App in a plain browser tab, outside any MCP
 * host. It runs the framework's own `agent-bundle serve-app` (agent-bundle#514)
 * against this install's built artifact: the packed `hauler` server launches
 * exactly as `mcp run` launches it, the App is bound to it through the
 * Workbench's host stack on a loopback origin, `hauler_status` is called once
 * so it opens populated, and `call-tool` is approved so the panels may poll;
 * the command stays in the foreground until Ctrl-C or the server exits. A
 * plain command, not a rendered one: an open browser tab has no render budget.
 *
 * The framework is spawned, never imported: a route that imported
 * `agent-bundle/api` would either inline the framework into every host pack's
 * bin or leave a bare import the artifact validator rejects (`AB6005`). The
 * packs stay self-contained, and `agent-bundle` is resolved from the project
 * at run time — the checkout has it under `node_modules`; the npm package
 * (no runtime dependencies, #82) and an installed host pack do not, and the
 * command says so.
 */
export const config = {
  description:
    'Open the cargo-hauler dashboard in a browser: serve the MCP App standalone against the plugin\'s own hauler server (from the plugin checkout) and stay in the foreground until Ctrl-C.',
  exitCode: 'result',
} satisfies CliRouteConfig;

export const inputSchema = z
  .object({
    noOpen: z.boolean().optional().describe('Print the URL without opening the default browser'),
    port: z.number().int().min(0).max(65_535).optional().describe('Loopback port for the host page (default 0: ephemeral)'),
    target: z
      .enum(['claude', 'codex', 'cursor', 'portable'])
      .optional()
      .describe('The built host pack whose hauler server to bind (default portable)'),
  })
  .strict();

export const resultSchema = z
  .object({
    exitCode: z.number().int().min(0).max(255),
    message: z.string(),
    operation: z.literal('dashboard'),
    /** The served host page, once `agent-bundle serve-app` printed it. */
    url: z.string().nullable(),
  })
  .strict();

type DashboardResult = z.infer<typeof resultSchema>;

/**
 * Where this CLI lives decides what it can serve: `dist/bin/cargo-hauler.js`
 * sits two levels under the project root (a checkout or the npm package),
 * whose `artifact/` holds every built host pack; `artifact/<host>/bin/
 * cargo-hauler.mjs` sits two levels under that artifact root. An installed
 * host pack is neither and has no artifact to serve from.
 */
const locateProject = (): { readonly artifact: string; readonly root: string } | undefined => {
  const here = fileURLToPath(new URL('../../', import.meta.url));
  if (existsSync(join(here, 'agent-bundle.manifest.json'))) {
    return { artifact: here, root: dirname(here) };
  }
  if (existsSync(join(here, 'artifact', 'agent-bundle.manifest.json'))) {
    return { artifact: join(here, 'artifact'), root: here };
  }
  return undefined;
};

/**
 * The framework's own CLI as the project resolves it: the `agent-bundle`
 * package under the nearest `node_modules` at or above the root, read from its
 * manifest's `bin`. Looked up by path, not `require.resolve`: the package's
 * `exports` declare no `require` condition, and an `import()` of it here
 * would drag the framework into every bin that carries this route.
 */
const frameworkCliPath = (root: string): string | undefined => {
  for (let directory = root; ; directory = dirname(directory)) {
    const packageDir = join(directory, 'node_modules', 'agent-bundle');
    const manifestPath = join(packageDir, 'package.json');
    if (existsSync(manifestPath)) {
      const manifest: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'));
      const bin = typeof manifest === 'object' && manifest !== null && 'bin' in manifest ? manifest.bin : undefined;
      const relative =
        typeof bin === 'string' ? bin : typeof bin === 'object' && bin !== null ? Reflect.get(bin, 'agent-bundle') : undefined;
      return typeof relative === 'string' ? resolve(packageDir, relative) : undefined;
    }
    if (directory === dirname(directory)) {
      return undefined;
    }
  }
};

const failure = (message: string): DashboardResult => ({ exitCode: 1, message, operation: 'dashboard', url: null });

const inHost = 'In an MCP host, call hauler_status instead — the dashboard App is attached to its result.';

/** `agent-bundle serve-app` prints `MCP App <app> at <url> (…)` once the host listens. */
const servedUrl = (line: string): string | undefined => /\bat (https?:\/\/\S+)/u.exec(line)?.[1];

/**
 * Runs the framework CLI in the foreground. The routed CLI owns stdout for the
 * result document, so the child's stdout — the URL line — is relayed to
 * stderr, the operator's channel; its stderr is inherited. The request signal
 * (Ctrl-C reaching the routed CLI) becomes the child's SIGTERM.
 */
const serve = (
  argv: readonly string[],
  signal: AbortSignal,
): Promise<{ readonly exitCode: number; readonly url: string | null }> =>
  new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, argv, { stdio: ['ignore', 'pipe', 'inherit'] });
    let url: string | null = null;
    let buffered = '';
    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      process.stderr.write(text);
      buffered += text;
      for (const line of buffered.split('\n').slice(0, -1)) {
        url ??= servedUrl(line) ?? null;
      }
      buffered = buffered.slice(buffered.lastIndexOf('\n') + 1);
    });
    const stop = (): void => {
      child.kill('SIGTERM');
    };
    signal.addEventListener('abort', stop, { once: true });
    child.once('error', reject);
    child.once('exit', (code, exitSignal) => {
      signal.removeEventListener('abort', stop);
      resolvePromise({ exitCode: code ?? (exitSignal === null ? 1 : 128), url });
    });
  });

export default async function Dashboard({ input, signal }: CliRouteProps<typeof inputSchema>): Promise<DashboardResult> {
  const project = locateProject();
  if (project === undefined) {
    return failure(
      `hauler dashboard runs from the plugin checkout, where the built artifact sits beside the CLI; an installed host pack has none. ${inHost}`,
    );
  }
  const cli = frameworkCliPath(project.root);
  if (cli === undefined) {
    return failure(
      `hauler dashboard needs agent-bundle resolvable from ${project.root} (\`pnpm install\` in the checkout; the npm package ships no runtime dependencies). ${inHost}`,
    );
  }
  const served = await serve(
    [
      cli,
      'serve-app',
      'hauler/dashboard',
      '--root',
      project.root,
      '--artifact',
      project.artifact,
      '--target',
      input.target ?? 'portable',
      '--tool',
      'hauler_status',
      '--allow',
      'call-tool',
      input.noOpen === true ? '--no-open' : '--open',
      ...(input.port === undefined ? [] : ['--port', String(input.port)]),
    ],
    signal,
  );
  return {
    exitCode: served.exitCode,
    message:
      served.exitCode === 0
        ? 'dashboard closed'
        : `agent-bundle serve-app exited with ${String(served.exitCode)}; see its diagnostics above`,
    operation: 'dashboard',
    url: served.url,
  };
}
