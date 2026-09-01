import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from '@rstest/core';
import * as Effect from 'effect/Effect';
import * as Schedule from 'effect/Schedule';

import { runExecClient } from '../src/client/exec.js';
import { resolveDaemonConfig } from '../src/daemon/config.js';
import type { DaemonConfigShape } from '../src/daemon/config.js';
import { pingDaemon } from '../src/daemon/control.js';
import { runDaemon } from '../src/daemon/main.js';

const fakeCargoScript = `#!/usr/bin/env bash
echo "fake-out:$*"
echo "fake-err:$*" >&2
if [ -n "\${FAKE_SLEEP:-}" ]; then sleep "\$FAKE_SLEEP"; fi
exit "\${FAKE_EXIT:-0}"
`;

interface Fixture {
  readonly binDir: string;
  readonly config: DaemonConfigShape;
  readonly root: string;
  readonly workspace: string;
}

const makeFixture = (): Fixture => {
  const root = mkdtempSync(join(tmpdir(), 'cc-exec-'));
  const stateDir = join(root, 'state');
  const binDir = join(root, 'bin');
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(binDir, 'cargo'), fakeCargoScript);
  chmodSync(join(binDir, 'cargo'), 0o755);
  const workspace = join(root, 'ws');
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, 'Cargo.toml'), '[package]\nname = "ws"\n');
  return {
    binDir,
    config: resolveDaemonConfig({ CARGO_CONDUCTOR_STATE_DIR: stateDir }),
    root,
    workspace,
  };
};

const collectIo = (): {
  readonly io: {
    readonly writeStderr: (data: string | Uint8Array) => void;
    readonly writeStdout: (data: Uint8Array) => void;
  };
  readonly stderr: () => string;
  readonly stdout: () => string;
} => {
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  const toBuffer = (data: string | Uint8Array): Buffer =>
    typeof data === 'string' ? Buffer.from(data) : Buffer.from(data);
  return {
    io: {
      writeStderr: (data) => {
        stderr.push(toBuffer(data));
      },
      writeStdout: (data) => {
        stdout.push(Buffer.from(data));
      },
    },
    stderr: () => Buffer.concat(stderr).toString('utf8'),
    stdout: () => Buffer.concat(stdout).toString('utf8'),
  };
};

const cargoEnv = (fixture: Fixture, extra: Record<string, string> = {}): Record<string, string> => ({
  PATH: `${fixture.binDir}:${process.env.PATH ?? ''}`,
  ...extra,
});

const withDaemon = <A>(use: (fixture: Fixture) => Effect.Effect<A, unknown>): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = makeFixture();
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => rmSync(fixture.root, { recursive: true, force: true })),
        );
        yield* Effect.forkScoped(runDaemon(fixture.config));
        yield* pingDaemon(fixture.config.socketPath, 500).pipe(
          Effect.retry(Schedule.spaced('50 millis').pipe(Schedule.intersect(Schedule.recurs(100)))),
        );
        return yield* use(fixture);
      }),
    ),
  );

describe('runExecClient', () => {
  it('streams brokered cargo output and injects queue/start progress', () =>
    withDaemon((fixture) =>
      Effect.gen(function* () {
        const collected = collectIo();
        const result = yield* runExecClient({
          argv: ['cargo', 'check'],
          autoSpawn: false,
          config: fixture.config,
          cwd: fixture.workspace,
          env: cargoEnv(fixture),
          io: collected.io,
        });

        expect(result.mode).toBe('brokered');
        expect(result.exitCode).toBe(0);
        expect(result.ticket).toMatch(/^cc-\d+$/u);
        expect(collected.stdout()).toContain('fake-out:check');
        expect(collected.stderr()).toContain('fake-err:check');
        expect(collected.stderr()).toMatch(/ticket cc-\d+ queued \(0 ahead/u);
        expect(collected.stderr()).toMatch(/ticket cc-\d+ started \(waited \d+ms\)/u);
      }),
    ));

  it('preserves a non-zero cargo exit code from the daemon', () =>
    withDaemon((fixture) =>
      Effect.gen(function* () {
        const collected = collectIo();
        const result = yield* runExecClient({
          argv: ['cargo', 'test'],
          autoSpawn: false,
          config: fixture.config,
          cwd: fixture.workspace,
          env: cargoEnv(fixture, { FAKE_EXIT: '17' }),
          io: collected.io,
        });

        expect(result.mode).toBe('brokered');
        expect(result.exitCode).toBe(17);
      }),
    ));

  it('falls through to a local cargo process when the daemon is unreachable', async () => {
    const fixture = makeFixture();
    const collected = collectIo();
    try {
      const result = await Effect.runPromise(
        runExecClient({
          argv: ['cargo', 'build'],
          autoSpawn: false,
          config: fixture.config,
          cwd: fixture.workspace,
          env: cargoEnv(fixture),
          io: collected.io,
        }),
      );

      expect(result).toEqual({ exitCode: 0, mode: 'passthrough' });
      expect(collected.stdout()).toContain('fake-out:build');
      expect(collected.stderr()).toContain('fake-err:build');
      expect(collected.stderr()).toContain('daemon unreachable; running cargo directly');
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('invokes ensureDaemon before falling back to passthrough', async () => {
    const fixture = makeFixture();
    const collected = collectIo();
    let ensured = 0;
    try {
      const result = await Effect.runPromise(
        runExecClient({
          argv: ['cargo', 'check'],
          config: fixture.config,
          cwd: fixture.workspace,
          ensureDaemon: () =>
            Effect.sync(() => {
              ensured += 1;
            }),
          env: cargoEnv(fixture),
          io: collected.io,
        }),
      );
      expect(ensured).toBe(1);
      expect(result.mode).toBe('passthrough');
      expect(collected.stdout()).toContain('fake-out:check');
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('emits heartbeat progress while a brokered run is in flight', () =>
    withDaemon((fixture) =>
      Effect.gen(function* () {
        const collected = collectIo();
        const result = yield* runExecClient({
          argv: ['cargo', 'check'],
          autoSpawn: false,
          config: fixture.config,
          cwd: fixture.workspace,
          env: cargoEnv(fixture, { FAKE_SLEEP: '0.35' }),
          heartbeatMs: 80,
          io: collected.io,
        });

        expect(result.mode).toBe('brokered');
        expect(result.exitCode).toBe(0);
        expect(collected.stderr()).toMatch(/still running \(\d+s\)/u);
      }),
    ));
});
