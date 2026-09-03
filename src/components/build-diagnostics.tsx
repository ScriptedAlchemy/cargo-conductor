import React from 'react';

import type { RequestRecord } from '../daemon/protocol.js';

import { CodeBlock, Heading, Table } from './primitives.js';
import { buildDiagnosticsModel } from './view-models.js';

export interface BuildDiagnosticsProps {
  readonly record: Pick<RequestRecord, 'diagnostics' | 'errorCount' | 'warningCount'>;
}

/**
 * Cargo diagnostics as structure: an index table with one row per
 * `error[E…]`/`warning:` block (code, message, first `-->` location) so an
 * agent can jump to the file, followed by every captured block verbatim —
 * spans, expected/found types, notes, and suggested fixes — because the index
 * is a way in, not a substitute for what rustc said.
 */
export const BuildDiagnostics = ({ record }: BuildDiagnosticsProps) => {
  const model = buildDiagnosticsModel(record);
  if (model.verbatim.trim() === '') {
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
      <CodeBlock lang="text">{model.verbatim}</CodeBlock>
    </>
  );
};
