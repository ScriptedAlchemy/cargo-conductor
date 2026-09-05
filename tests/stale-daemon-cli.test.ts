import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'effect-rstest';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const haulerEntry = join(repoRoot, 'dist', 'bin', 'hauler.js');
const fixtureEntry = join(repoRoot, 'tests', 'fixtures', 'stale-daemon.mjs');

interface ChildResult {
  readonly code: number;
  readonly stderr: string;
  readonly stdout: string;
}

const children = new Set<ChildProcess>();

afterEach(() => {
  for (const child of children) {
    child.kill('SIGTERM');
  }
  children.clear();
});

const run = (
  entry: string,
  args: readonly string[],
  env: Readonly<Record<string, string>>,
): Promise<ChildResult> =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry, ...args], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.add(child);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.once('error', reject);
    child.once('close', (code) => {
      children.delete(child);
      resolve({ code: code ?? 1, stderr, stdout });
    });
  });

const startStaleDaemon = (
  socketPath: string,
  logPath: string,
  mode: 'replaceable' | 'stubborn',
): Promise<ChildProcess> =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fixtureEntry, socketPath, logPath, mode], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    children.add(child);
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code !== 0 && code !== null) {
        reject(new Error(`stale daemon exited before readiness (${code})`));
      }
    });
    child.stdout.setEncoding('utf8');
    child.stdout.once('data', (chunk: string) => {
      if (chunk.includes('ready')) {
        resolve(child);
      } else {
        reject(new Error(`unexpected stale-daemon readiness output: ${chunk}`));
      }
    });
  });

describe.skipIf(!existsSync(haulerEntry))('stale daemon CLI replacement', () => {
  it('replaces a stale daemon before parsing its older status payload', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cargo-hauler-stale-cli-'));
    const stateDir = join(root, 'state');
    const logPath = join(root, 'requests.log');
    const env = {
      CARGO_HAULER_KACHE_INDEX: '',
      CARGO_HAULER_STATE_DIR: stateDir,
    };
    try {
      await startStaleDaemon(join(stateDir, 'daemon.sock'), logPath, 'replaceable');
      const status = await run(haulerEntry, ['status', '--json'], env);

      expect(status.code).toBe(0);
      expect(status.stderr).not.toContain('ZodError');
      expect(JSON.parse(status.stdout)).toMatchObject({
        daemon: 'running',
        operation: 'status',
      });
      expect(readFileSync(logPath, 'utf8').trim().split('\n')).toEqual(['ping', 'shutdown']);
      await run(haulerEntry, ['daemon', 'stop'], env);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it('reports one clear failure when the stale daemon cannot be replaced', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cargo-hauler-stubborn-cli-'));
    const stateDir = join(root, 'state');
    const logPath = join(root, 'requests.log');
    const env = {
      CARGO_HAULER_KACHE_INDEX: '',
      CARGO_HAULER_STATE_DIR: stateDir,
    };
    try {
      await startStaleDaemon(join(stateDir, 'daemon.sock'), logPath, 'stubborn');
      const status = await run(haulerEntry, ['daemon', 'status'], env);
      const output = `${status.stdout}${status.stderr}`;

      expect(status.code).toBe(1);
      expect(output).toContain('cargo-hauler daemon pid');
      expect(output).toContain('(0.6.0) is still running');
      expect(output).toContain('not restarted');
      expect(output).not.toContain('ZodError');
      expect(readFileSync(logPath, 'utf8').trim().split('\n')).toEqual(['ping', 'shutdown']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
