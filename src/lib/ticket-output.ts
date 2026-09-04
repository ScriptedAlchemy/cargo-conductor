import { closeSync, openSync, readSync, statSync } from 'node:fs';

import type { RequestRecord } from '../daemon/protocol.js';

import { stripAnsi } from './ansi.js';

/**
 * The on-disk full output log of a ticket, as a document can show it. The
 * daemon writes `<stateDir>/tickets/<ticket>.log` (see daemon/ticket-log.ts)
 * and records the path on the request row; the CLI and MCP routes run on the
 * same machine as the daemon, so they read the file directly.
 */
export type TicketOutputModel =
  /** No log: the run never started, logs are disabled, or the row predates them. */
  | { readonly kind: 'none' }
  /** The log exists; only its location and size are shown. */
  | { readonly kind: 'available'; readonly path: string; readonly sizeBytes: number }
  /** The row names a log that is no longer on disk (retention, a cleared state dir). */
  | { readonly kind: 'missing'; readonly path: string }
  /** The log's text, as rendered by `--full`; `omittedBytes` were cut from the front to fit. */
  | {
      readonly kind: 'full';
      readonly path: string;
      readonly sizeBytes: number;
      readonly text: string;
      readonly omittedBytes: number;
    };

/**
 * The framework rejects a rendered document over 1 MiB
 * (`DEFAULT_AGENT_RENDER_LIMITS.maxDocumentBytes`), JSON escaping included.
 * 768 KiB of log leaves room for the ticket card and the escaping overhead.
 */
export const maxRenderedOutputBytes = 768 * 1024;

const statSize = (path: string): number | null => {
  try {
    return statSync(path).size;
  } catch {
    return null;
  }
};

/**
 * Reads the last `maxBytes` of the file. For a cargo test run the summary —
 * the `failures:` list and each `---- <test> stdout ----` panic section — is
 * at the end, so when the log does not fit the tail is the useful part; the
 * head is what the caller already watched scroll by.
 */
const readTail = (
  path: string,
  sizeBytes: number,
  maxBytes: number,
): { readonly text: string; readonly omittedBytes: number } | null => {
  const offset = Math.max(0, sizeBytes - maxBytes);
  const length = sizeBytes - offset;
  const buffer = Buffer.alloc(length);
  let fd: number | null = null;
  try {
    fd = openSync(path, 'r');
    let read = 0;
    while (read < length) {
      const count = readSync(fd, buffer, read, length - read, offset + read);
      if (count === 0) {
        break;
      }
      read += count;
    }
    const raw = buffer.subarray(0, read).toString('utf8');
    if (offset === 0) {
      return { omittedBytes: 0, text: raw };
    }
    // Start on a line boundary: the cut landed mid-line (and possibly
    // mid-character); what precedes the first newline is a fragment.
    const firstNewline = raw.indexOf('\n');
    const text = firstNewline === -1 ? raw : raw.slice(firstNewline + 1);
    return { omittedBytes: sizeBytes - Buffer.byteLength(text, 'utf8'), text };
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      closeSync(fd);
    }
  }
};

/**
 * Projects a request's `outputPath` onto what the document should show.
 * `full` reads the log (bounded, ANSI stripped like every other structured
 * surface); otherwise only its existence and size are checked.
 */
export const loadTicketOutput = (
  record: Pick<RequestRecord, 'outputPath'> | null,
  full: boolean,
  maxBytes = maxRenderedOutputBytes,
): TicketOutputModel => {
  const path = record?.outputPath ?? null;
  if (path === null) {
    return { kind: 'none' };
  }
  const sizeBytes = statSize(path);
  if (sizeBytes === null) {
    return { kind: 'missing', path };
  }
  if (!full) {
    return { kind: 'available', path, sizeBytes };
  }
  const tail = readTail(path, sizeBytes, maxBytes);
  if (tail === null) {
    return { kind: 'missing', path };
  }
  return {
    kind: 'full',
    omittedBytes: tail.omittedBytes,
    path,
    sizeBytes,
    text: stripAnsi(tail.text),
  };
};

/** Bytes per rendered code block; the framework also caps a document at 10 000 nodes. */
export const outputChunkBytes = 64 * 1024;

/**
 * Splits log text into code-block-sized pieces at line boundaries, so no
 * single Markdown node carries the whole log and every piece is a complete
 * set of lines.
 */
export const chunkOutput = (text: string, chunkBytes = outputChunkBytes): readonly string[] => {
  const chunks: string[] = [];
  let current: string[] = [];
  let currentBytes = 0;
  for (const line of text.replace(/\n$/u, '').split('\n')) {
    const lineBytes = Buffer.byteLength(line, 'utf8') + 1;
    if (currentBytes > 0 && currentBytes + lineBytes > chunkBytes) {
      chunks.push(current.join('\n'));
      current = [];
      currentBytes = 0;
    }
    current.push(line);
    currentBytes += lineBytes;
  }
  if (current.length > 0) {
    chunks.push(current.join('\n'));
  }
  return chunks;
};
