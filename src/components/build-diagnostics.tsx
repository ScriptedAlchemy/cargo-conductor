import React from 'react';

import type { RequestRecord } from '../daemon/protocol.js';

import { CodeBlock, Heading, Table } from './primitives.js';
import { buildDiagnosticsModel } from './view-models.js';

export interface BuildDiagnosticsProps {
  readonly record: Pick<RequestRecord, 'diagnostics' | 'errorCount' | 'warningCount'>;
}

/**
 * Cargo diagnostics as structure: one row per `error[E…]`/`warning:` block
 * with its code, message, and first `-->` location, so an agent can jump to
 * the file instead of scrolling raw output. Blocks the parser does not
 * recognise are shown verbatim rather than dropped.
 */
export const BuildDiagnostics = ({ record }: BuildDiagnosticsProps) => {
  const model = buildDiagnosticsModel(record);
  if (model.rows.length === 0 && model.unparsed.length === 0) {
    return null;
  }
  return (
    <>
      <Heading>Diagnostics</Heading>
      {model.rows.length === 0 ? null : (
        <Table
          columns={['Level', 'Code', 'Message', 'Location']}
          rows={model.rows.map((row) => [row.level, row.code ?? '—', row.message, row.location ?? '—'])}
        />
      )}
      {model.unparsed.length === 0 ? null : <CodeBlock lang="text">{model.unparsed.join('')}</CodeBlock>}
    </>
  );
};
