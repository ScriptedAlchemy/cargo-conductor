import type { CliRouteConfig, CliRouteProps } from 'agent-bundle';
import { z } from 'zod';

import { runDaemonControl } from '../daemon/lifecycle.js';
import { daemonResultSchema } from '../lib/protocol-schemas.js';

export const config = {
  description: 'Control the hauler daemon: run in the foreground, start detached, stop, or report status.',
  exitCode: 'result',
  positionals: ['subcommand'],
} satisfies CliRouteConfig;

export const inputSchema = z.object({
  subcommand: z.enum(['run', 'start', 'stop', 'status']),
});

export const resultSchema = daemonResultSchema.extend({
  exitCode: z.number().int().min(0).max(255),
});

export default async function Daemon({ input }: CliRouteProps<typeof inputSchema>) {
  const result = await runDaemonControl(input.subcommand);
  return { ...result, exitCode: daemonExitCode(result) };
}

const daemonExitCode = (result: Awaited<ReturnType<typeof runDaemonControl>>): number => {
  switch (result.subcommand) {
    case 'run':
      return result.message === 'completed' || result.message === 'already-running' ? 0 : 1;
    case 'start':
    case 'status':
      return result.running ? 0 : 1;
    case 'stop':
      return 0;
    default: {
      const exhaustive: never = result.subcommand;
      return exhaustive;
    }
  }
};
