import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as Effect from 'effect/Effect';
import * as Schedule from 'effect/Schedule';
import type * as Scope from 'effect/Scope';

import { resolveDaemonConfig } from '../src/daemon/config.js';
import type { DaemonConfigShape } from '../src/daemon/config.js';
import { pingDaemon, requestOverSocket } from '../src/daemon/control.js';
import { createLedgerApi, openLedgerDatabase } from '../src/daemon/ledger.js';
import type { LedgerApi } from '../src/daemon/ledger.js';
import { runDaemon } from '../src/daemon/main.js';
import type {
  ExitMessage,
  OutputMessage,
  ServerMessage,
  StatusReport,
  StatusResultMessage,
} from '../src/daemon/protocol.js';

const fakeCargoScript = `#!/usr/bin/env bash
echo "fake-out:$*"
echo "fake-err:$*" >&2
echo "fake-jobs:\${CARGO_BUILD_JOBS:-none}" >&2
if [ -n "\${FAKE_OUTPUT_COUNT:-}" ]; then
  fake_output_index=0
  while [ "\$fake_output_index" -lt "\$FAKE_OUTPUT_COUNT" ]; do
    sleep "\${FAKE_OUTPUT_INTERVAL:-0.04}"
    echo "fake-tick:\$fake_output_index"
    fake_output_index=\$((fake_output_index + 1))
  done
fi
if [ -n "\${FAKE_SLEEP:-}" ]; then sleep "\$FAKE_SLEEP"; fi
if [ -n "\${FAKE_LATE_OUT:-}" ]; then echo "\$FAKE_LATE_OUT"; fi
exit "\${FAKE_EXIT:-0}"
`;

export interface Fixture {
  readonly config: DaemonConfigShape;
  readonly root: string;
  readonly binDir: string;
  readonly ws1: string;
  readonly ws2: string;
}

/**
 * Temp roots must be realpath-canonical: the daemon canonicalizes every path
 * it stores, so expectations built from fixture paths would otherwise fail
 * on platforms where the temp dir traverses a symlink (macOS `/var/folders`
 * is a symlink into `/private/var`).
 */
const canonicalTempDir = (prefix: string): string =>
  realpathSync(mkdtempSync(join(tmpdir(), prefix)));

const makeFixture = (
  maxConcurrent: number,
  env: Readonly<Record<string, string>> = {},
): Fixture => {
  const root = canonicalTempDir('cargo-hauler-it-');
  const stateDir = join(root, 'state');
  const binDir = join(root, 'bin');
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(binDir, 'cargo'), fakeCargoScript);
  chmodSync(join(binDir, 'cargo'), 0o755);
  const makeWorkspace = (name: string): string => {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'Cargo.toml'), `[package]\nname = "${name}"\n`);
    return dir;
  };
  const config = resolveDaemonConfig({
    CARGO_HAULER_STATE_DIR: stateDir,
    CARGO_HAULER_MAX_CONCURRENT: String(maxConcurrent),
    CARGO_HAULER_BATCH_WINDOW_MS: '0',
    // Hermetic tests: the fixture daemon's admission must not depend on the
    // host's CPU or memory pressure at the moment the suite runs (a swapping
    // host would park every fake cargo at the gate for up to two minutes).
    CARGO_HAULER_CPU_PRESSURE_THRESHOLD: '0',
    CARGO_HAULER_MEM_PRESSURE_SOFT: 'off',
    CARGO_HAULER_MEM_PRESSURE_HARD: 'off',
    CARGO_HAULER_MEM_AVAILABLE_MIN_GB: 'off',
    CARGO_HAULER_HEAVY_MEM_AVAILABLE_GB: 'off',
    // Hermetic tests: no live kache priors.
    CARGO_HAULER_KACHE_INDEX: '',
    ...env,
  });
  return { config, root, binDir, ws1: makeWorkspace('ws1'), ws2: makeWorkspace('ws2') };
};

export const scopedFixture = (
  maxConcurrent: number,
  env: Readonly<Record<string, string>> = {},
): Effect.Effect<Fixture, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync(() => makeFixture(maxConcurrent, env)),
    (fixture) => Effect.sync(() => rmSync(fixture.root, { recursive: true, force: true })),
  );

export const scopedDaemon = (maxConcurrent: number): Effect.Effect<Fixture, unknown, Scope.Scope> =>
  Effect.gen(function* () {
    const fixture = yield* scopedFixture(maxConcurrent);
    yield* Effect.forkScoped(runDaemon(fixture.config));
    yield* pingDaemon(fixture.config.socketPath, 500).pipe(
      Effect.retry(Schedule.spaced('50 millis').pipe(Schedule.upTo({ times: 100 }))),
    );
    return fixture;
  });

export const scopedTempDir = (
  prefix: string,
): Effect.Effect<string, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync(() => canonicalTempDir(prefix)),
    (directory) => Effect.sync(() => rmSync(directory, { recursive: true, force: true })),
  );

export const scopedDatabase = <Database extends { close(): void }>(
  open: () => Database,
): Effect.Effect<Database, never, Scope.Scope> =>
  Effect.acquireRelease(Effect.sync(open), (database) => Effect.sync(() => database.close()));

export const scopedLedger = (
  config: Pick<DaemonConfigShape, 'databasePath'>,
): Effect.Effect<LedgerApi, never, Scope.Scope> =>
  Effect.map(
    scopedDatabase(() => openLedgerDatabase(config.databasePath)),
    createLedgerApi,
  );

export const scopedEnv = (
  overrides: Readonly<Record<string, string | undefined>>,
): Effect.Effect<void, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const saved = Object.fromEntries(
        Object.keys(overrides).map((name) => [name, process.env[name]]),
      );
      for (const [name, value] of Object.entries(overrides)) {
        if (value === undefined) {
          delete process.env[name];
        } else {
          process.env[name] = value;
        }
      }
      return saved;
    }),
    (saved) =>
      Effect.sync(() => {
        for (const [name, value] of Object.entries(saved)) {
          if (value === undefined) {
            delete process.env[name];
          } else {
            process.env[name] = value;
          }
        }
      }),
  ).pipe(Effect.asVoid);

export const fakeCargoEnv = (
  fixture: Pick<Fixture, 'binDir'>,
  extra: Readonly<Record<string, string>> = {},
): Record<string, string> => ({
  CARGO_HAULER_CARGO_BIN: join(fixture.binDir, 'cargo'),
  PATH: `${fixture.binDir}:${process.env.PATH ?? ''}`,
  ...extra,
});

export const shortId = (): string => randomUUID().slice(0, 8);

export interface ExecOptions {
  readonly cwd: string;
  readonly argv?: readonly string[];
  readonly session?: string;
  readonly host?: string;
  readonly sleep?: string;
  readonly exit?: string;
  readonly lateOut?: string;
  readonly extraEnv?: Readonly<Record<string, string>>;
  readonly isTerminal?: (message: ServerMessage) => boolean;
  readonly timeoutMs?: number;
}

export const execRequest = (fixture: Fixture, options: ExecOptions) => {
  const env: Record<string, string> = {
    ...fakeCargoEnv(fixture),
    ...options.extraEnv,
  };
  if (options.sleep !== undefined) {
    env.FAKE_SLEEP = options.sleep;
  }
  if (options.exit !== undefined) {
    env.FAKE_EXIT = options.exit;
  }
  if (options.lateOut !== undefined) {
    env.FAKE_LATE_OUT = options.lateOut;
  }
  return requestOverSocket({
    socketPath: fixture.config.socketPath,
    message: {
      type: 'exec',
      id: shortId(),
      argv: [...(options.argv ?? ['cargo', 'check'])],
      cwd: options.cwd,
      env,
      ...(options.session === undefined ? {} : { session: options.session }),
      ...(options.host === undefined ? {} : { host: options.host }),
    },
    isTerminal:
      options.isTerminal ?? ((message) => message.type === 'exit' || message.type === 'error'),
    timeoutMs: options.timeoutMs ?? 8_000,
  });
};

export const fetchReport = (fixture: Fixture): Effect.Effect<StatusReport, unknown> =>
  requestOverSocket({
    socketPath: fixture.config.socketPath,
    message: { type: 'status', id: shortId(), limit: 100 },
    isTerminal: (message) => message.type === 'status-result',
  }).pipe(
    Effect.map((messages) => {
      const result = messages.find(
        (message): message is StatusResultMessage => message.type === 'status-result',
      );
      if (result === undefined) {
        throw new Error('status-result missing');
      }
      return result.report;
    }),
  );

export const pollReport = (
  fixture: Fixture,
  predicate: (report: StatusReport) => boolean,
  attempts = 60,
): Effect.Effect<StatusReport, unknown> =>
  Effect.gen(function* () {
    const report = yield* fetchReport(fixture);
    if (predicate(report)) {
      return report;
    }
    if (attempts <= 0) {
      return yield* Effect.die(new Error('polled condition never became true'));
    }
    yield* Effect.sleep('100 millis');
    return yield* pollReport(fixture, predicate, attempts - 1);
  });

export const findExit = (messages: readonly ServerMessage[]): ExitMessage => {
  const exit = messages.find((message): message is ExitMessage => message.type === 'exit');
  if (exit === undefined) {
    throw new Error(`no exit message in ${JSON.stringify(messages)}`);
  }
  return exit;
};

export const decodeOutput = (
  messages: readonly ServerMessage[],
  channel: 'stdout' | 'stderr',
): string =>
  messages
    .filter(
      (message): message is OutputMessage =>
        message.type === 'output' && message.channel === channel,
    )
    .map((message) => Buffer.from(message.data, 'base64').toString('utf8'))
    .join('');
