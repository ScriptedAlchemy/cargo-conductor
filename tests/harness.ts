import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as Effect from 'effect/Effect';
import * as Schedule from 'effect/Schedule';

import { resolveDaemonConfig } from '../src/daemon/config.js';
import type { DaemonConfigShape } from '../src/daemon/config.js';
import { pingDaemon, requestOverSocket } from '../src/daemon/control.js';
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

export const makeFixture = (maxConcurrent: number): Fixture => {
  const root = mkdtempSync(join(tmpdir(), 'cc-it-'));
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
    CARGO_CONDUCTOR_STATE_DIR: stateDir,
    CARGO_CONDUCTOR_MAX_CONCURRENT: String(maxConcurrent),
    CARGO_CONDUCTOR_BATCH_WINDOW_MS: '0',
    CARGO_CONDUCTOR_CPU_PRESSURE_THRESHOLD: '0',
    // Hermetic tests: no live kache priors.
    CARGO_CONDUCTOR_KACHE_INDEX: '',
  });
  return { config, root, binDir, ws1: makeWorkspace('ws1'), ws2: makeWorkspace('ws2') };
};

export const withTempDir = async <A>(
  prefix: string,
  use: (directory: string) => A | PromiseLike<A>,
): Promise<A> => {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  try {
    return await use(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

export const withFixture = <A>(
  maxConcurrent: number,
  use: (fixture: Fixture) => Effect.Effect<A, unknown>,
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = makeFixture(maxConcurrent);
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => rmSync(fixture.root, { recursive: true, force: true })),
        );
        return yield* use(fixture);
      }),
    ),
  );

export const withDaemon = <A>(
  maxConcurrent: number,
  use: (fixture: Fixture) => Effect.Effect<A, unknown>,
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = makeFixture(maxConcurrent);
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => rmSync(fixture.root, { recursive: true, force: true })),
        );
        yield* Effect.forkScoped(runDaemon(fixture.config));
        yield* pingDaemon(fixture.config.socketPath, 500).pipe(
          Effect.retry(Schedule.spaced('50 millis').pipe(Schedule.upTo({ times: 100 }))),
        );
        return yield* use(fixture);
      }),
    ),
  );

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
    PATH: `${fixture.binDir}:${process.env.PATH ?? ''}`,
    // The executor refuses to resolve bare `cargo` through PATH (shim
    // recursion guard); pin jobs at the fixture's fake cargo explicitly.
    CARGO_CONDUCTOR_CARGO_BIN: join(fixture.binDir, 'cargo'),
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
