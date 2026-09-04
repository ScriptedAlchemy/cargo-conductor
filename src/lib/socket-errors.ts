/**
 * The errno (`ECONNREFUSED`, `ENOENT`, `EACCES`, …) behind a failed socket
 * operation. Walks both `cause` chains and Effect's Socket error wrappers:
 * `SocketError` nests the syscall error under `.reason`, not `.cause`, and
 * missing that once made a dead socket look like a non-absent failure. Null
 * when no code is found within six levels. Pure: hooks import it too.
 */
export const socketErrorCode = (cause: unknown): string | null => {
  let current = cause;
  for (let depth = 0; depth < 6; depth += 1) {
    if (typeof current !== 'object' || current === null) {
      return null;
    }
    if ('code' in current && typeof current.code === 'string') {
      return current.code;
    }
    if ('cause' in current && current.cause !== undefined && current.cause !== null) {
      current = current.cause;
      continue;
    }
    if ('reason' in current && current.reason !== undefined && current.reason !== null) {
      current = current.reason;
      continue;
    }
    return null;
  }
  return null;
};

/** Socket errors that mean no daemon process owns the socket path. */
export const absentSocketCodes: ReadonlySet<string> = new Set(['ECONNREFUSED', 'ENOENT']);
