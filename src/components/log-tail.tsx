import { Agent } from '@agent-bundle/runtime';
import React from 'react';

import { CodeBlock } from './primitives.js';

export interface LogTailProps {
  /** Whether the daemon captured this tail from a run still in progress. */
  readonly live: boolean;
  readonly maxLines?: number;
  readonly text: string | null;
}

const lastLines = (text: string, limit: number): string => {
  const lines = text.replace(/\n$/u, '').split('\n');
  return lines.length <= limit
    ? lines.join('\n')
    : `… (${lines.length - limit} earlier lines omitted)\n${lines.slice(-limit).join('\n')}`;
};

/**
 * The captured cargo output tail. `live` labels a snapshot of a run still
 * producing output — the shape `hauler_await` streams while it waits and
 * `hauler_result` returns for a running ticket — against the settled tail of
 * a finished one.
 */
export const LogTail = ({ live, maxLines = 40, text }: LogTailProps) => {
  if (text === null || text.trim() === '') {
    return null;
  }
  return (
    <>
      <Agent.Text>{live ? 'Live output tail:' : 'Output tail:'}</Agent.Text>
      <CodeBlock lang="text">{lastLines(text, maxLines)}</CodeBlock>
    </>
  );
};
