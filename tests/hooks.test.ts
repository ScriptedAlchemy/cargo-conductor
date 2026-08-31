import { describe, expect, it } from '@rstest/core';

import { handleAfterShell } from '../src/hooks/after-shell.js';
import { handleBeforeShell } from '../src/hooks/before-shell.js';

describe('shell hooks', () => {
  it('fails open on beforeTool without rewriting input', () => {
    expect(handleBeforeShell({ toolInput: { command: 'cargo test' }, toolName: 'shell' })).toEqual({
      outcome: 'continue',
    });
  });

  it('continues afterTool without denying or replacing input', () => {
    expect(handleAfterShell({ toolInput: { command: 'cargo test' }, toolName: 'shell' })).toEqual({
      outcome: 'continue',
    });
  });
});
