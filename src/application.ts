import { defineRscApplication } from '@agent-bundle/rsc-runtime/plugin';

import { daemonOperations, defaultDaemonOperations, type DaemonOperations } from './operations/daemon.js';
import {
  defaultInspectOperations,
  inspectOperations,
  type InspectOperations,
} from './operations/inspect.js';

export type ConductorOperations = DaemonOperations & InspectOperations;

const operationDefinitions = (operations: ConductorOperations) =>
  Object.freeze([
    ...inspectOperations(operations),
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
      ...options.operations,
    }),
    version: '0.1.0',
  });

export const conductorApplication = createConductorApplication();
