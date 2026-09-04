import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'effect-rstest';
import * as Effect from 'effect/Effect';

import { createLedgerApi, openLedgerDatabase } from '../src/daemon/ledger.js';
import {
  openTicketLog,
  sweepTicketLogs,
  ticketLogDirFor,
  ticketLogPath,
} from '../src/daemon/ticket-log.js';

import { scopedDatabase, scopedTempDir } from './harness.js';

describe('ticket log writer', () => {
  it('names the log after the ticket under <stateDir>/tickets', () => {
    expect(ticketLogDirFor('/state')).toBe('/state/tickets');
    expect(ticketLogPath('/state/tickets', 'cc-12')).toBe('/state/tickets/cc-12.log');
  });

  it.live('creates the directory lazily and appends chunks in arrival order, bytes verbatim', () =>
    Effect.gen(function* () {
      const root = yield* scopedTempDir('cc-ticket-log-');
      const directory = join(root, 'state', 'tickets');
      expect(existsSync(directory)).toBe(false);
      const log = openTicketLog(directory, 'cc-1', 1024 * 1024);
      expect(log).not.toBeNull();
      if (log === null) {
        return;
      }
      expect(log.path).toBe(join(directory, 'cc-1.log'));
      log.write(Buffer.from('   Compiling aa v0.1.0\n'));
      // ANSI stays as captured: consumers strip at display time.
      log.write(Buffer.from('\u001b[31merror\u001b[0m: boom\n'));
      log.write(Buffer.from('test result: FAILED\n'));
      yield* log.close();
      expect(log.truncated).toBe(false);
      expect(readFileSync(log.path, 'utf8')).toBe(
        '   Compiling aa v0.1.0\n\u001b[31merror\u001b[0m: boom\ntest result: FAILED\n',
      );
    }));

  it.live('stops appending at the byte bound and writes one final truncation line', () =>
    Effect.gen(function* () {
      const root = yield* scopedTempDir('cc-ticket-log-bound-');
      const directory = join(root, 'tickets');
      const log = openTicketLog(directory, 'cc-2', 20);
      expect(log).not.toBeNull();
      if (log === null) {
        return;
      }
      log.write(Buffer.from('0123456789\n'));
      log.write(Buffer.from('abcdefghij\n'));
      log.write(Buffer.from('never written\n'));
      log.write(Buffer.from('nor this\n'));
      yield* log.close();
      expect(log.truncated).toBe(true);
      const text = readFileSync(log.path, 'utf8');
      expect(text.startsWith('0123456789\n')).toBe(true);
      expect(text).not.toContain('never written');
      expect(text).not.toContain('nor this');
      const lines = text.trimEnd().split('\n');
      expect(lines.at(-1)).toMatch(
        /^\[cargo-hauler\] output log truncated at 20 bytes \(CARGO_HAULER_TICKET_LOG_MAX_BYTES\); later output was not written$/u,
      );
      expect(lines.filter((line) => line.includes('truncated'))).toHaveLength(1);
    }));

  it.live('returns null when the directory cannot be created', () =>
    Effect.gen(function* () {
      const root = yield* scopedTempDir('cc-ticket-log-unwritable-');
      // A regular file where the log directory should be: mkdir fails.
      const blocker = join(root, 'tickets');
      writeFileSync(blocker, 'not a directory');
      expect(openTicketLog(blocker, 'cc-3', 1024)).toBeNull();
    }));
});

describe('ticket log sweep', () => {
  it.effect('removes logs whose ticket has no ledger row and keeps the rest', () =>
    Effect.gen(function* () {
      const root = yield* scopedTempDir('cc-ticket-log-sweep-');
      const db = yield* scopedDatabase(() => openLedgerDatabase(join(root, 'ledger.db')));
      const ledger = createLedgerApi(db);
      const kept = yield* ledger.createRequest({
        argv: ['cargo', 'check'],
        createdAtMs: 1_000,
        cwd: '/repo',
        host: 'claude',
        intentJson: null,
        intentKey: null,
        laneKey: 'lane',
        session: null,
        targetDir: '/repo/target',
        workspaceRoot: '/repo',
      });
      const directory = join(root, 'tickets');
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, `${kept.ticket}.log`), 'kept\n');
      writeFileSync(join(directory, 'cc-999.log'), 'orphaned\n');
      writeFileSync(join(directory, 'notes.txt'), 'not a ticket log\n');

      const removed = yield* sweepTicketLogs(directory, ledger);
      expect(removed).toBe(1);
      expect(existsSync(join(directory, `${kept.ticket}.log`))).toBe(true);
      expect(existsSync(join(directory, 'cc-999.log'))).toBe(false);
      expect(existsSync(join(directory, 'notes.txt'))).toBe(true);
    }));

  it.effect('is a no-op when the directory does not exist yet', () =>
    Effect.gen(function* () {
      const root = yield* scopedTempDir('cc-ticket-log-sweep-none-');
      const db = yield* scopedDatabase(() => openLedgerDatabase(join(root, 'ledger.db')));
      const removed = yield* sweepTicketLogs(join(root, 'tickets'), createLedgerApi(db));
      expect(removed).toBe(0);
    }));
});
