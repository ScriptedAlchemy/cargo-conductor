import { defineOperation, type RscOperationContext } from '@agent-bundle/rsc-runtime/plugin';

import { parseDaemonSubcommand, runDaemonControl } from '../daemon/lifecycle.js';
import { ConductorResult } from '../result.js';

import {
  daemonInputSchema,
  daemonResultSchema,
  type DaemonInput,
  type DaemonResult,
} from './schemas.js';

export interface DaemonOperations {
  readonly daemon: (input: DaemonInput, context: RscOperationContext) => Promise<DaemonResult>;
}

export const defaultDaemonOperations: DaemonOperations = {
  daemon: (input) => runDaemonControl(input.subcommand),
};

export const daemonOperations = (operations: DaemonOperations) => [
  defineOperation({
    cli: {
      exitCode: (result) => {
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
      },
      name: 'daemon',
      parse: (argv) => ({ subcommand: parseDaemonSubcommand(argv) }),
      summary: 'Control the conductor daemon.',
      usage: 'daemon <run|start|stop|status>',
    },
    execute: operations.daemon,
    id: 'daemon',
    inputSchema: daemonInputSchema,
    render: (receipt) => <ConductorResult receipt={receipt} />,
    resultSchema: daemonResultSchema,
  }),
];
