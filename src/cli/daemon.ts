import type { CliRouteConfig, CliRouteProps } from 'agent-bundle';
import { z } from 'zod';

import { daemonExitCode, runDaemonControl } from '../daemon/lifecycle.js';
import { daemonResultSchema } from '../lib/protocol-schemas.js';

export const config = {
  description:
    'Control the hauler daemon: run in the foreground, start detached, stop, restart (stop, wait for exit, start), or report status.',
  exitCode: 'result',
  positionals: ['subcommand'],
} satisfies CliRouteConfig;

export const inputSchema = z.object({
  subcommand: z.enum(['run', 'start', 'stop', 'status', 'restart']),
});

export const resultSchema = daemonResultSchema.extend({
  exitCode: z.number().int().min(0).max(255),
});

export default async function Daemon({ input }: CliRouteProps<typeof inputSchema>) {
  const result = await runDaemonControl(input.subcommand);
  return { ...result, exitCode: daemonExitCode(result) };
}
