import { defineRscApplication } from '@agent-bundle/rsc-runtime/plugin';

import { packageVersion } from './lib/version.js';
import { daemonOperations, defaultDaemonOperations, type DaemonOperations } from './operations/daemon.js';
import {
  defaultInspectOperations,
  inspectOperations,
  type InspectOperations,
} from './operations/inspect.js';
import {
  defaultTicketOperations,
  ticketOperations,
  type TicketOperations,
} from './operations/tickets.js';

export type ConductorOperations = DaemonOperations & InspectOperations & TicketOperations;

const operationDefinitions = (operations: ConductorOperations) =>
  Object.freeze([
    ...inspectOperations(operations),
    ...ticketOperations(operations),
    ...daemonOperations(operations),
  ]);

export const createConductorApplication = (
  options: { readonly operations?: ConductorOperations } = {},
) =>
  defineRscApplication({
    description:
      'Coalesce, schedule, and stream cargo so concurrent agent sessions share compiles instead of fighting locks.',
    name: 'cargo-conductor',
    operations: operationDefinitions({
      ...defaultDaemonOperations,
      ...defaultInspectOperations,
      ...defaultTicketOperations,
      ...options.operations,
    }),
    version: packageVersion,
  });

export const conductorApplication = createConductorApplication();
