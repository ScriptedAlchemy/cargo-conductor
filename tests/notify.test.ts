import { describe, expect, it } from '@rstest/core';

import { handleAfterShell } from '../src/hooks/after-shell.js';

describe('afterTool completion notify', () => {
  it('injects additionalContext for tickets that finished since the last cursor', async () => {
    const result = await handleAfterShell(
      {
        sessionId: 'sess-1',
        toolInput: { command: 'conductor exec -- cargo check' },
        toolName: 'Bash',
        toolResponse: { exitCode: 0 },
      },
      { nativeEvent: 'PostToolUse', target: 'claude' },
      {
        completedSince: async () => [
          { error: null, exitCode: 0, status: 'done', ticket: 'cc-42' },
          { error: 'boom', exitCode: 101, status: 'failed', ticket: 'cc-43' },
        ],
        nowMs: () => 50,
        readCursor: () => 10,
        record: () => undefined,
        writeCursor: () => undefined,
      },
    );

    expect(result.outcome).toBe('continue');
    expect(result.additionalContext).toContain('cc-42 finished: success, 0 errors');
    expect(result.additionalContext).toContain('call conductor_result cc-42');
    expect(result.additionalContext).toContain('cc-43 finished: failed');
  });

  it('stays silent when nothing completed or the daemon is down', async () => {
    const silent = await handleAfterShell(
      { sessionId: 'sess-1', toolInput: { command: 'ls' } },
      { target: 'claude' },
      {
        completedSince: async () => [],
        record: () => undefined,
      },
    );
    expect(silent).toEqual({ outcome: 'continue' });

    const down = await handleAfterShell(
      { sessionId: 'sess-1', toolInput: { command: 'ls' } },
      { target: 'claude' },
      {
        completedSince: async () => {
          throw new Error('down');
        },
        record: () => undefined,
      },
    );
    expect(down).toEqual({ outcome: 'continue' });
  });
});
