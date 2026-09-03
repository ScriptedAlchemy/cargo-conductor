import { Agent } from '@agent-bundle/runtime';
import React from 'react';

export interface Field {
  readonly label: string;
  readonly value: string | number | boolean | null | undefined;
}

const singleLine = (value: string): string => value.replaceAll(/\s*\n\s*/gu, ' ');

/** Label/value bullets; null, undefined, and empty strings are dropped so callers can pass optionals directly. */
export const DataList = ({ fields }: { readonly fields: readonly Field[] }) => {
  const lines = fields.flatMap(({ label, value }) =>
    value === null || value === undefined || value === ''
      ? []
      : [`- **${label}:** ${singleLine(String(value))}`],
  );
  return lines.length === 0 ? null : <Agent.Markdown>{lines.join('\n')}</Agent.Markdown>;
};

const cell = (value: string): string => singleLine(value).replaceAll('|', '\\|');

export interface TableProps {
  readonly columns: readonly string[];
  readonly rows: readonly (readonly string[])[];
}

export const Table = ({ columns, rows }: TableProps) => (
  <Agent.Markdown>
    {[
      `| ${columns.join(' | ')} |`,
      `| ${columns.map(() => '---').join(' | ')} |`,
      ...rows.map((row) => `| ${row.map(cell).join(' | ')} |`),
    ].join('\n')}
  </Agent.Markdown>
);

export const Heading = ({ children }: { readonly children: string }) => (
  <Agent.Markdown>{`### ${children}`}</Agent.Markdown>
);

/** Fenced block; a fence longer than any backtick run inside keeps cargo output from escaping. */
export const CodeBlock = ({ children, lang = '' }: { readonly children: string; readonly lang?: string }) => {
  const longestRun = Math.max(2, ...[...children.matchAll(/`+/gu)].map((match) => match[0].length));
  const fence = '`'.repeat(longestRun + 1);
  return <Agent.Markdown>{`${fence}${lang}\n${children.replace(/\n$/u, '')}\n${fence}`}</Agent.Markdown>;
};
