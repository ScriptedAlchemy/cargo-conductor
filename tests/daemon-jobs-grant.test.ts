import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'effect-rstest';
import * as Effect from 'effect/Effect';

import { isSharedJobserverArmed, jobserverFifoFileName } from '../src/daemon/jobserver.js';
import { cargoExecEnv } from '../src/daemon/lane-exec.js';

import { decodeOutput, execRequest, findExit, scopedDaemon } from './harness.js';

const input = (argv: readonly string[], env: Record<string, string> = {}) => ({ argv, env });

describe('cargoExecEnv', () => {
  it('lets the armed jobserver own parallelism instead of pinning CARGO_BUILD_JOBS', () => {
    expect(cargoExecEnv(4, input(['cargo', 'check']), true)).toEqual({});
    expect(cargoExecEnv(4, input(['cargo', 'check'], { RUSTFLAGS: '-Dwarnings' }), true)).toEqual({
      RUSTFLAGS: '-Dwarnings',
    });
  });

  it('falls back to the per-run grant only while the jobserver is not armed', () => {
    expect(cargoExecEnv(4, input(['cargo', 'check']), false)).toEqual({ CARGO_BUILD_JOBS: '4' });
    expect(cargoExecEnv(0, input(['cargo', 'check']), false)).toEqual({});
  });

  it('never overrides a caller-pinned parallelism', () => {
    expect(cargoExecEnv(4, input(['cargo', 'check', '-j2']), false)).toEqual({});
    expect(cargoExecEnv(4, input(['cargo', 'check', '-j', '2']), false)).toEqual({});
    expect(cargoExecEnv(4, input(['cargo', 'check', '--jobs=2']), false)).toEqual({});
    expect(cargoExecEnv(4, input(['cargo', 'check'], { CARGO_BUILD_JOBS: '9' }), false)).toEqual({
      CARGO_BUILD_JOBS: '9',
    });
  });
});

const envReportingCargo = `#!/usr/bin/env bash
echo "jobs:\${CARGO_BUILD_JOBS:-none}"
echo "makeflags:\${MAKEFLAGS:-none}"
exit 0
`;

describe('daemon-spawned cargo parallelism', () => {
  it.live('joins the shared FIFO through MAKEFLAGS and leaves CARGO_BUILD_JOBS unset', () =>
    Effect.gen(function* () {
      const fixture = yield* scopedDaemon(2);
      expect(isSharedJobserverArmed()).toBe(true);
      expect(fixture.config.jobsGrant).toBeGreaterThan(0);
      const dir = join(fixture.root, 'env-cargo');
      mkdirSync(dir, { recursive: true });
      const cargoPath = join(dir, 'cargo');
      writeFileSync(cargoPath, envReportingCargo);
      chmodSync(cargoPath, 0o755);

      const messages = yield* execRequest(fixture, {
        cwd: fixture.ws1,
        argv: ['cargo', 'test', '-p', 'jobs-probe'],
        extraEnv: { CARGO_HAULER_CARGO_BIN: cargoPath },
      });
      expect(findExit(messages).status).toBe('done');
      const stdout = decodeOutput(messages, 'stdout');
      expect(stdout).toContain('jobs:none\n');
      expect(stdout).toContain(
        `--jobserver-auth=fifo:${join(fixture.config.stateDir, jobserverFifoFileName)}`,
      );
    }));
});
