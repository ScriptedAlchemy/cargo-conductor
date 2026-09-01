import { fstatSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from '@rstest/core';
import * as Effect from 'effect/Effect';

import type { DaemonConfigShape } from '../src/daemon/config.js';
import { spawnDetachedDaemon } from '../src/client/ensure-daemon.js';

const configAt = (stateDir: string): DaemonConfigShape => ({
  stateDir,
  socketPath: join(stateDir, 'daemon.sock'),
  databasePath: join(stateDir, 'ledger.db'),
  lockTargetPath: join(stateDir, 'daemon.pid'),
  logPath: join(stateDir, 'daemon.log'),
  maxConcurrent: 1,
  outputTailBytes: 1024,
  replayBufferBytes: 1024,
  kacheIndexPath: '',
  jobsGrant: 1,
  batchEnabled: false,
  loadThresholdPerCore: null,
  loadMinConcurrent: 2,
});

describe('spawnDetachedDaemon', () => {
  it('closes the log descriptor and returns a typed failure when spawn throws', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'cc-ensure-daemon-'));
    let logFd = -1;
    try {
      const error = await Effect.runPromise(
        Effect.flip(
          spawnDetachedDaemon(configAt(stateDir), '/missing/entry.js', {
            spawnProcess: (_command, _args, options) => {
              const stdio = options.stdio;
              if (!Array.isArray(stdio) || typeof stdio[1] !== 'number') {
                throw new Error('test expected the log descriptor in stdio');
              }
              logFd = stdio[1];
              throw new Error('spawn exploded');
            },
          }),
        ),
      );

      expect(error._tag).toBe('SpawnDaemonError');
      expect(error.cause).toBeInstanceOf(Error);
      expect(() => fstatSync(logFd)).toThrow();
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
