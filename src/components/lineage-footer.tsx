import { Agent, useAgent } from '@agent-bundle/runtime';
import React from 'react';

import { lineageLine, lineageModel } from './view-models.js';

/**
 * The shell footer: which conversation this document was rendered for. A
 * synchronous component, so it reads the request through `useAgent()` — the
 * same handle `await agent()` returns, under the same lease — and stays
 * silent when the host cannot place the request in a conversation tree
 * (bare stdio, routed CLI, rendered scripts) rather than printing a guess.
 */
export const LineageFooter = () => {
  const request = useAgent();
  const lineage = lineageModel(request.lineage);
  if (lineage === null) {
    return null;
  }
  return <Agent.Context>{`Requested by ${lineageLine(lineage)}. Tickets submitted here are attributed to it.`}</Agent.Context>;
};
