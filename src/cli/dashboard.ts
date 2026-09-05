import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { CliRouteConfig, CliRouteProps } from 'agent-bundle';
import { ServeAppCommandError, spawnServeApp, type ServeAppExit, type SpawnedServeApp } from 'agent-bundle/serve-app-command';
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
 * The framework is spawned, never imported: a route that value-imported
 * `agent-bundle/api` would inline the compiler into every host pack's bin
 * (`AB4837`). `spawnServeApp` from `agent-bundle/serve-app-command`
 * (agent-bundle#558) is the sanctioned shape — dependency-free, so it bundles
 * into the bin — and owns resolving the installed framework CLI, spawning it,
 * relaying its stdout to stderr so this command keeps stdout for its result,
 * waiting for the ready line, and turning the request signal into the child's
 * SIGTERM. What it cannot know is where this install keeps its artifact: the
 * checkout has it under `node_modules` and `artifact/`; the npm package (no
 * runtime dependencies, #82) and an installed host pack do not, and the
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
    /** The served host page, once `agent-bundle serve-app` printed its ready line. */
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

const inHost = 'In an MCP host, call hauler_status instead — the dashboard App is attached to its result.';

const failure = (exitCode: number, message: string): DashboardResult => ({ exitCode, message, operation: 'dashboard', url: null });

/** The child's exit as this command's: its code, or 1 for an exit with neither code nor signal, or 128 for a signal. */
const exitCodeOf = ({ code, signal }: ServeAppExit): number => code ?? (signal === null ? 1 : 128);

export default async function Dashboard({ input, signal }: CliRouteProps<typeof inputSchema>): Promise<DashboardResult> {
  const project = locateProject();
  if (project === undefined) {
    return failure(
      1,
      `hauler dashboard runs from the plugin checkout, where the built artifact sits beside the CLI; an installed host pack has none. ${inHost}`,
    );
  }
  let served: SpawnedServeApp;
  try {
    served = await spawnServeApp({
      app: 'hauler/dashboard',
      root: project.root,
      artifact: project.artifact,
      target: input.target ?? 'portable',
      tool: 'hauler_status',
      autoApprove: ['call-tool'],
      open: input.noOpen !== true,
      ...(input.port === undefined ? {} : { port: input.port }),
      // Ctrl-C reaching the routed CLI stops the server.
      signal,
    });
  } catch (error) {
    if (error instanceof ServeAppCommandError) {
      // framework-not-installed, artifact-missing, exited-before-ready (with
      // the child's exit), spawn-failed, aborted, stop-failed.
      return failure(error.exit === undefined ? 1 : exitCodeOf(error.exit), `${error.message} ${inHost}`);
    }
    throw error;
  }
  const exit = await served.closed;
  return {
    exitCode: exitCodeOf(exit),
    message:
      exit.code === 0
        ? 'dashboard closed'
        : `agent-bundle serve-app exited with ${exit.signal ?? String(exit.code)}; see its diagnostics above`,
    operation: 'dashboard',
    url: served.url,
  };
}
