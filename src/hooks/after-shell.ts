export interface AfterShellEvent {
  readonly toolInput?: { readonly command?: string };
  readonly toolName?: string;
  readonly toolResponse?: unknown;
}

export interface AfterShellResult {
  readonly additionalContext?: string;
  readonly outcome: 'continue';
}

/** Ledger recording lands later; afterTool cannot deny or replace input. */
export const handleAfterShell = (_event: AfterShellEvent): AfterShellResult => ({
  outcome: 'continue',
});

export default handleAfterShell;
