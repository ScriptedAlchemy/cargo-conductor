import { createWriteStream, mkdirSync, readdirSync, rmSync } from 'node:fs';
import type { WriteStream } from 'node:fs';
import { join } from 'node:path';

import * as Effect from 'effect/Effect';

import type { LedgerApi } from './ledger.js';
import { parseTicket } from './protocol.js';

/**
 * Per-ticket full output logs: `<stateDir>/tickets/<ticket>.log` holds every
 * output chunk of a leader run as the broker emitted it, so a finished ticket
 * can be triaged after the fact instead of re-running the command (#68). The
 * ledger row keeps only a bounded tail; this file is the whole thing, up to
 * `CARGO_HAULER_TICKET_LOG_MAX_BYTES`.
 */

export const ticketLogDirFor = (stateDir: string): string => join(stateDir, 'tickets');

export const ticketLogPath = (directory: string, ticket: string): string =>
  join(directory, `${ticket}.log`);

const truncationLine = (maxBytes: number): string =>
  `\n[cargo-hauler] output log truncated at ${maxBytes} bytes (CARGO_HAULER_TICKET_LOG_MAX_BYTES); later output was not written\n`;

/**
 * One open log. Writes go through a single append stream for the life of the
 * run (no per-chunk `appendFileSync`); the stream buffers in memory and
 * drains on the event loop, and `close` waits for the flush so a
 * `hauler result --full` issued right after the exit sees complete content.
 * A stream error is remembered and silences the writer: the ticket's cargo
 * run must never fail because its log could not be written.
 */
export class TicketLogWriter {
  readonly path: string;
  readonly #stream: WriteStream;
  readonly #maxBytes: number;
  #written = 0;
  #truncated = false;
  #failed = false;

  constructor(path: string, stream: WriteStream, maxBytes: number) {
    this.path = path;
    this.#stream = stream;
    this.#maxBytes = maxBytes;
    stream.on('error', () => {
      this.#failed = true;
    });
  }

  /** True once the byte bound was hit and the final truncation line was written. */
  get truncated(): boolean {
    return this.#truncated;
  }

  get bytesWritten(): number {
    return this.#written;
  }

  write(data: Uint8Array): void {
    if (
      this.#failed ||
      this.#truncated ||
      data.byteLength === 0 ||
      this.#stream.destroyed ||
      this.#stream.writableEnded
    ) {
      return;
    }
    if (this.#written + data.byteLength > this.#maxBytes) {
      this.#truncated = true;
      this.#push(Buffer.from(truncationLine(this.#maxBytes)));
      return;
    }
    this.#written += data.byteLength;
    this.#push(Buffer.from(data));
  }

  #push(chunk: Buffer): void {
    try {
      this.#stream.write(chunk);
    } catch {
      this.#failed = true;
    }
  }

  /** Ends the stream and resolves once its buffered chunks reached the file (or it errored). */
  close(): Effect.Effect<void> {
    return Effect.callback<void>((resume) => {
      if (this.#stream.destroyed || this.#stream.writableEnded) {
        resume(Effect.void);
        return;
      }
      this.#stream.end(() => resume(Effect.void));
    });
  }
}

/**
 * Opens `<directory>/<ticket>.log` for a leader about to start, creating the
 * directory on first use. Null when the directory cannot be created or the
 * stream cannot be constructed: the run proceeds without a log and the
 * ledger records no `output_path`. The file is truncated on open, not
 * appended to: a ticket runs as a leader at most once, so any existing file
 * is stale.
 */
export const openTicketLog = (
  directory: string,
  ticket: string,
  maxBytes: number,
): TicketLogWriter | null => {
  const path = ticketLogPath(directory, ticket);
  try {
    mkdirSync(directory, { recursive: true });
    return new TicketLogWriter(path, createWriteStream(path, { flags: 'w' }), maxBytes);
  } catch {
    return null;
  }
};

const logFilePattern = /^(cc-\d+)\.log$/u;

/**
 * Startup pass: removes `cc-N.log` files whose ticket no longer has a ledger
 * row. Runs right after ledger retention, so the logs of the rows retention
 * just deleted go with them, along with anything left by a ledger reset.
 * Files that are not ticket logs are left alone. Returns the count removed.
 */
export const sweepTicketLogs = (
  directory: string,
  ledger: Pick<LedgerApi, 'hasRequest'>,
): Effect.Effect<number> =>
  Effect.gen(function* () {
    const entries = yield* Effect.sync(() => {
      try {
        return readdirSync(directory);
      } catch {
        return [] as string[];
      }
    });
    let removed = 0;
    for (const entry of entries) {
      const match = logFilePattern.exec(entry);
      const id = match?.[1] === undefined ? null : parseTicket(match[1]);
      if (id === null) {
        continue;
      }
      if (yield* ledger.hasRequest(id)) {
        continue;
      }
      yield* Effect.sync(() => {
        rmSync(join(directory, entry), { force: true });
      });
      removed += 1;
    }
    return removed;
  });
