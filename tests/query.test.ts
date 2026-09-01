import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from '@rstest/core';
import * as Effect from 'effect/Effect';
import * as Schedule from 'effect/Schedule';

import { resolveDaemonConfig } from '../src/daemon/config.js';
import { pingDaemon, requestOverSocket } from '../src/daemon/control.js';
import { createLedgerApi, openLedgerDatabase } from '../src/daemon/ledger.js';
import { runDaemon } from '../src/daemon/main.js';
import { loadConductorSnapshot } from '../src/query.js';

const isolatedConfig = () => {
  const root = mkdtempSync(join(tmpdir(), 'cc-query-'));
  return {
    config: resolveDaemonConfig({ CARGO_CONDUCTOR_STATE_DIR: join(root, 'state') }),
    root,
  };
};

describe('loadConductorSnapshot', () => {
  it('reports a stopped daemon and empty history when nothing has run', async () => {
    const { config, root } = isolatedConfig();
    try {
      const snapshot = await Effect.runPromise(loadConductorSnapshot({ config }));
      expect(snapshot.daemon).toBe('stopped');
      expect(snapshot.active).toEqual([]);
      expect(snapshot.recent).toEqual([]);
      expect(snapshot.lanes).toEqual([]);
      expect(snapshot.summary).toContain('daemon is not running');
      expect(snapshot.stateRoot).toBe(config.stateDir);
      expect(snapshot.socketPath).toBe(config.socketPath);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reads the ledger when the daemon is down', async () => {
    const { config, root } = isolatedConfig();
    try {
      const db = openLedgerDatabase(config.databasePath);
      const ledger = createLedgerApi(db);
      Effect.runSync(
        ledger.createRequest({
          argv: ['cargo', 'check'],
          createdAtMs: 1_000,
          cwd: '/repo',
          host: 'cursor',
          intentJson: null,
          intentKey: 'k',
          laneKey: '/repo::/repo/target',
          session: 's',
          targetDir: '/repo/target',
          workspaceRoot: '/repo',
        }),
      );
      Effect.runSync(ledger.markFinished(1, { atMs: 2_000, exitCode: 0, status: 'done' }));
      db.close();

      const snapshot = await Effect.runPromise(loadConductorSnapshot({ config, recentLimit: 10 }));
      expect(snapshot.daemon).toBe('stopped');
      expect(snapshot.recent).toHaveLength(1);
      expect(snapshot.recent[0]?.ticket).toBe('cc-1');
      expect(snapshot.recent[0]?.status).toBe('done');
      expect(snapshot.summary).toContain('1 recorded request');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('uses the live daemon report when the broker is up', async () => {
    const { config, root } = isolatedConfig();
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => rmSync(root, { recursive: true, force: true })),
          );
          yield* Effect.forkScoped(runDaemon(config));
          yield* pingDaemon(config.socketPath, 500).pipe(
            Effect.retry(Schedule.spaced('50 millis').pipe(Schedule.upTo({ times: 100 }))),
          );
          yield* requestOverSocket({
            isTerminal: (message) => message.type === 'status-result',
            message: { id: 'snap', type: 'status' },
            socketPath: config.socketPath,
          });
          const snapshot = yield* loadConductorSnapshot({ config });
          expect(snapshot.daemon).toBe('running');
          expect(snapshot.pid).toBe(process.pid);
          expect(snapshot.summary).toContain('daemon is running');
        }),
      ),
    );
  });
});
