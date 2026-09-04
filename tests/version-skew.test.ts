import { mkdirSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { join } from 'node:path';

import { version as cliVersion } from 'agent-bundle/meta';
import { describe, expect, it } from 'effect-rstest';
import * as Effect from 'effect/Effect';
import type * as Scope from 'effect/Scope';

import { daemonBadgeModel } from '../src/components/view-models.js';
import { resolveDaemonConfig } from '../src/daemon/config.js';
import type { DaemonConfigShape } from '../src/daemon/config.js';
import { statusDaemon } from '../src/daemon/lifecycle.js';
import { probeDaemonHealth } from '../src/lib/daemon-health.js';
import { loadStatusResult } from '../src/lib/inspect.js';
import { LineBuffer } from '../src/lib/ndjson.js';
import { statusSummary } from '../src/lib/status-filter.js';
import { fetchTicketResult } from '../src/lib/tickets.js';
import {
  DaemonVersionSkewError,
  describeFirstIssue,
  formatVersionSkew,
  versionSkewLine,
} from '../src/lib/version-skew.js';
import { loadHaulerSnapshot } from '../src/query.js';
import { scopedTempDir } from './harness.js';

/**
 * A CLI upgraded under a daemon left running from an older install (#75):
 * the daemon's replies are read leniently, and when they still cannot be
 * read the failure names both versions and the restart, never a raw Zod dump.
 */
const nowMs = 1_800_000_000_000;

const legacyRecord = {
  argv: ['cargo', 'check'],
  attachMode: null,
  attachedTo: null,
  background: false,
  createdAtMs: nowMs - 60_000,
  cwd: '/ws',
  diagnostics: null,
  error: null,
  errorCount: null,
  estimateMs: null,
  execArgv: null,
  exitCode: null,
  finishedAtMs: null,
  holdStop: false,
  host: 'cursor',
  id: 3518,
  intentJson: null,
  intentKey: null,
  laneKey: '["/ws","/ws/target"]',
  outputTail: null,
  queuedAtMs: nowMs - 60_000,
  runMs: null,
  session: null,
  signal: null,
  startedAtMs: nowMs - 50_000,
  status: 'running',
  targetDir: '/ws/target',
  ticket: 'cc-3518',
  waitMs: 0,
  warningCount: null,
  workspaceRoot: '/ws',
};

const legacyReport = (records: readonly Record<string, unknown>[]) => ({
  active: records,
  lanes: [],
  maxConcurrent: 5,
  pid: 741314,
  recent: [],
  socketPath: '/home/me/.cache/cargo-hauler/daemon.sock',
  startedAtMs: nowMs - 3 * 3_600_000,
});

interface FakeDaemon {
  readonly config: DaemonConfigShape;
}

/**
 * A stand-in for an older daemon: answers `ping` with its own version and
 * `status`/`result` with whatever record shape the test hands it.
 */
const scopedFakeDaemon = (
  version: string,
  record: Record<string, unknown>,
): Effect.Effect<FakeDaemon, never, Scope.Scope> =>
  Effect.gen(function* () {
    const root = yield* scopedTempDir('cargo-hauler-skew-');
    const config = resolveDaemonConfig({ CARGO_HAULER_STATE_DIR: join(root, 'state') });
    mkdirSync(config.stateDir, { recursive: true });
    const sockets = new Set<Socket>();
    const startedAtMs = Date.now() - 3 * 3_600_000;
    const reply = (message: Record<string, unknown>): Record<string, unknown> | null => {
      switch (message.type) {
        case 'ping':
          return { id: message.id, pid: 741314, startedAtMs, type: 'pong', version };
        case 'status':
          return { id: message.id, report: legacyReport([record]), type: 'status-result' };
        case 'result':
          return { id: message.id, request: record, type: 'result-result' };
        default:
          return null;
      }
    };
    yield* Effect.acquireRelease(
      Effect.callback<Server>((resume) => {
        const server = createServer((socket) => {
          sockets.add(socket);
          const lines = new LineBuffer();
          socket.on('data', (chunk) => {
            for (const line of lines.push(chunk)) {
              const answer = reply(JSON.parse(line) as Record<string, unknown>);
              if (answer !== null) {
                socket.write(`${JSON.stringify(answer)}\n`);
              }
            }
          });
        });
        server.listen(config.socketPath, () => resume(Effect.succeed(server)));
      }),
      (server) =>
        Effect.callback<void>((resume) => {
          for (const socket of sockets) {
            socket.destroy();
          }
          server.close(() => resume(Effect.void));
        }),
    );
    return { config };
  });

describe('version skew wording', () => {
  it('names the first mismatch by path, without the raw issue array', () => {
    expect(
      describeFirstIssue([
        {
          code: 'invalid_type',
          expected: 'string',
          message: 'Invalid input: expected string, received undefined',
          path: ['active', 0, 'outputPath'],
        },
      ]),
    ).toBe('active[0].outputPath expected string, received undefined');
    expect(describeFirstIssue([])).toBe('reply did not match the protocol');
  });

  it('reads as a version-skew problem with both versions and the restart, zod detail second', () => {
    const skew = new DaemonVersionSkewError({
      cliVersion: '0.4.4',
      daemon: { pid: 741314, startedAtMs: nowMs - 3 * 3_600_000, version: '0.4.1' },
      firstMismatch: 'active[0].outputPath expected string, received undefined',
      socketPath: '/tmp/daemon.sock',
    });
    expect(formatVersionSkew(skew, nowMs).split('\n')).toEqual([
      'daemon is 0.4.1 (pid 741314, since 3h ago), this CLI is 0.4.4 — restart it with `hauler daemon restart`',
      'first mismatch: active[0].outputPath expected string, received undefined',
    ]);
  });

  it('still points at the restart when the daemon answered no ping or runs the same version', () => {
    const silent = new DaemonVersionSkewError({
      cliVersion: '0.4.4',
      daemon: null,
      firstMismatch: 'active[0].laneKey expected string, received undefined',
      socketPath: '/tmp/daemon.sock',
    });
    const [headline, detail] = formatVersionSkew(silent, nowMs).split('\n');
    expect(headline).toContain('this CLI is 0.4.4');
    expect(headline).toContain('did not answer a ping');
    expect(headline).toContain('hauler daemon restart');
    expect(detail).toBe('first mismatch: active[0].laneKey expected string, received undefined');

    const same = new DaemonVersionSkewError({
      cliVersion: '0.4.4',
      daemon: { pid: 7, startedAtMs: nowMs, version: '0.4.4' },
      firstMismatch: 'x',
      socketPath: '/tmp/daemon.sock',
    });
    expect(formatVersionSkew(same, nowMs)).toContain('same version as this CLI');
  });

  it('flags a version difference as a one-line warning, and nothing when they agree or are unknown', () => {
    expect(versionSkewLine('0.4.2', '0.4.4')).toBe('daemon 0.4.2 ≠ cli 0.4.4 — restart it with `hauler daemon restart`');
    expect(versionSkewLine('0.4.4', '0.4.4')).toBeNull();
    expect(versionSkewLine(undefined, '0.4.4')).toBeNull();
  });

  it('shows the skew on the daemon badge and in the status header', () => {
    const model = daemonBadgeModel(
      { busyLanes: 0, latencyMs: 1, maxConcurrent: 5, pid: 42, queued: 0, riding: 0, running: 0, startedAtMs: nowMs, state: 'running', version: '0.4.2' },
      nowMs,
      { cliVersion: '0.4.4' },
    );
    expect(model.skew).toBe('daemon 0.4.2 ≠ cli 0.4.4 — restart it with `hauler daemon restart`');
    expect(statusSummary('running', [], [], { cliVersion: '0.4.4', daemonVersion: '0.4.2' })).toBe(
      'cargo-hauler daemon is running; 0 active, 0 recent; daemon 0.4.2 ≠ cli 0.4.4 — restart it with `hauler daemon restart`',
    );
    expect(statusSummary('running', [], [], { cliVersion: '0.4.4', daemonVersion: '0.4.4' })).toBe(
      'cargo-hauler daemon is running; 0 active, 0 recent',
    );
  });
});

describe('an older daemon under a newer CLI', () => {
  it.live('reads a 0.4.1 status reply and reports the version difference as a warning', () =>
    Effect.gen(function* () {
      const daemon = yield* scopedFakeDaemon('0.4.1', legacyRecord);
      const snapshot = yield* loadHaulerSnapshot({ config: daemon.config });
      expect(snapshot.daemon).toBe('running');
      expect(snapshot.active[0]?.outputPath).toBeNull();
      expect(snapshot.daemonVersion).toBe('0.4.1');
      expect(snapshot.summary).toContain(`daemon 0.4.1 ≠ cli ${cliVersion}`);

      const health = yield* Effect.promise(() => probeDaemonHealth(daemon.config));
      expect(health).toMatchObject({ pid: 741314, state: 'running', version: '0.4.1' });
      const badge = daemonBadgeModel(health, Date.now(), { cliVersion });
      expect(badge.skew).toBe(`daemon 0.4.1 ≠ cli ${cliVersion} — restart it with \`hauler daemon restart\``);
    }));

  it.live('reports an unreadable status reply as version skew, not as a Zod issue array', () =>
    Effect.gen(function* () {
      const { laneKey: _laneKey, ...unreadable } = legacyRecord;
      const daemon = yield* scopedFakeDaemon('0.3.9', unreadable);
      const failure = yield* Effect.flip(
        Effect.tryPromise({
          catch: (error) => (error instanceof Error ? error.message : String(error)),
          try: (signal) => loadStatusResult({}, { config: daemon.config, signal }),
        }),
      );
      const [headline, detail, ...rest] = failure.split('\n');
      expect(headline).toBe(
        `daemon is 0.3.9 (pid 741314, since 3h ago), this CLI is ${cliVersion} — restart it with \`hauler daemon restart\``,
      );
      expect(detail).toBe('first mismatch: active[0].laneKey expected string, received undefined');
      expect(rest).toEqual([]);
      expect(failure).not.toContain('invalid_type');

      // `hauler daemon status` says the same instead of failing.
      const status = yield* statusDaemon(daemon.config);
      expect(status.running).toBe(true);
      expect(status.pid).toBe(741314);
      expect(status.message).toContain('daemon is 0.3.9');
      expect(status.message).toContain('hauler daemon restart');
    }));

  it.live('reports an unreadable ticket reply the same way on result', () =>
    Effect.gen(function* () {
      const { laneKey: _laneKey, ...unreadable } = legacyRecord;
      const daemon = yield* scopedFakeDaemon('0.3.9', unreadable);
      const failure = yield* Effect.flip(
        Effect.tryPromise({
          catch: (error) => (error instanceof Error ? error.message : String(error)),
          try: (signal) => fetchTicketResult({ ticket: 'cc-3518' }, { config: daemon.config, signal }),
        }),
      );
      expect(failure.split('\n')[0]).toContain('daemon is 0.3.9 (pid 741314');
      expect(failure).toContain(`this CLI is ${cliVersion}`);
      expect(failure).toContain('first mismatch: laneKey expected string, received undefined');
      expect(failure).not.toContain('"path"');
    }));
});
