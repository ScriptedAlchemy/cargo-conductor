export interface BeforeShellEvent {
  readonly toolInput?: { readonly command?: string };
  readonly toolName?: string;
}

export interface BeforeShellResult {
  readonly additionalContext?: string;
  readonly outcome: 'continue' | 'deny';
  readonly reason?: string;
  readonly updatedInput?: Readonly<Record<string, unknown>>;
}

/**
 * Fail-open: if the daemon is unreachable or this is not a cargo command,
 * the original shell input is left unchanged. Rewrite/deny land in a later
 * phase; a deny cannot also rewrite.
 */
export const handleBeforeShell = (_event: BeforeShellEvent): BeforeShellResult => ({
  outcome: 'continue',
});

export default handleBeforeShell;
