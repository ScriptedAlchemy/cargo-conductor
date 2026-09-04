import { Agent } from '@agent-bundle/runtime';
import React from 'react';

import { formatBytes } from '../lib/format.js';
import { chunkOutput } from '../lib/ticket-output.js';
import type { TicketOutputModel } from '../lib/ticket-output.js';

import { CodeBlock } from './primitives.js';
import { UnavailableState } from './states.js';
import type { SurfaceNames } from './surface.js';

export interface FullOutputProps {
  readonly names: SurfaceNames;
  readonly output: TicketOutputModel;
  readonly ticket: string;
}

/**
 * The on-disk full output log of a ticket (#68). Without `full` it is one
 * line naming the file and its size, so an agent triaging a red ticket knows
 * the whole run is retrievable without re-running it; with `full` it is the
 * log itself, one code block per chunk, cut from the front when the file
 * would not fit the rendered-document budget.
 */
export const FullOutput = ({ names, output, ticket }: FullOutputProps) => {
  switch (output.kind) {
    case 'none':
      return null;
    case 'available':
      return (
        <Agent.Text>
          {`Full output: ${output.path} (${formatBytes(output.sizeBytes)}) — read it with ${names.resultFull(ticket)}`}
        </Agent.Text>
      );
    case 'missing':
      return (
        <UnavailableState what={`full output ${output.path}`}>
          the log file is no longer on disk (ledger retention removed it, or the state directory was cleared); only the stored tail remains.
        </UnavailableState>
      );
    case 'full': {
      const chunks = chunkOutput(output.text);
      return (
        <>
          <Agent.Text>{`Full output (${formatBytes(output.sizeBytes)}): ${output.path}`}</Agent.Text>
          {output.omittedBytes > 0 ? (
            <Agent.Context>
              {`Showing the last ${formatBytes(output.sizeBytes - output.omittedBytes)} of ${formatBytes(output.sizeBytes)}; the first ${formatBytes(output.omittedBytes)} are omitted here to fit the document. The whole run is in ${output.path}.`}
            </Agent.Context>
          ) : null}
          {chunks.length === 0 ? (
            <Agent.Text>The log is empty: the run produced no output.</Agent.Text>
          ) : (
            chunks.map((chunk, index) => (
              <CodeBlock key={index} lang="text">
                {chunk}
              </CodeBlock>
            ))
          )}
        </>
      );
    }
    default: {
      const exhaustive: never = output;
      return exhaustive;
    }
  }
};
