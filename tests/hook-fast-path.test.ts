import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { HookEvent, HookHandlerContext } from 'agent-bundle/config';
import { describe, expect, it } from 'effect-rstest';
import * as Effect from 'effect/Effect';

import { runExecClient } from '../src/client/exec.js';
import { handleAfterShell } from '../src/hooks/after-shell.js';
import { handleBeforeShell } from '../src/hooks/before-shell.js';
import { allowOutput } from '../src/hooks/fast-path/allow-output.js';
import { pingSessionCompleted, type SessionCompletedPing } from '../src/hooks/fast-path/session-ping.js';
import { createAfterToolHandler } from '../src/hooks/fast-path/shell-after.js';
import { createBeforeToolHandler, projectBeforeShellResult } from '../src/hooks/fast-path/shell-before.js';
import type { FinishedTicket } from '../src/hooks/finished-ticket.js';
import type { HookRecord } from '../src/hooks/record.js';
import type { DeniedAttempt } from '../src/hooks/rpc.js';
import type { HookServices } from '../src/hooks/shared.js';

import { fakeCargoEnv, pollReport, scopedDaemon } from './harness.js';

/**
 * The shell hook entries decide on the raw command before the rewrite and
 * telemetry modules are evaluated. These tests inject the deferred import as
 * a spy: a non-cargo command must never trigger it, a cargo command must get
 * exactly the decision the event route used to render, and `allow` — the one
 * decision the config-declared contract cannot carry — must be written in the
 * host's own shape.
 */

type Host = HookHandlerContext['target'];

const contextFor = (host: Host, nativeInput: Readonly<Record<string, unknown>> = {}): HookHandlerContext => ({
  nativeEvent: host === 'cursor' ? 'preToolUse' : 'PreToolUse',
  nativeInput,
  target: host,
});

const afterContextFor = (host: Host): HookHandlerContext => ({
  nativeEvent: host === 'cursor' ? 'postToolUse' : 'PostToolUse',
  nativeInput: {},
  target: host,
});

const beforeEvent = (command: string | undefined, overrides: Partial<HookEvent<'beforeTool'>> = {}): HookEvent<'beforeTool'> => ({
  cwd: '/tmp/ws',
  sessionId: 'sess-claude',
  toolInput: command === undefined ? { file_path: '/tmp/ws/Cargo.toml' } : { command },
  toolName: command === undefined ? 'Read' : 'Bash',
  toolUseId: 'toolu_fast',
  transcriptPath: '/tmp/transcript.json',
  ...overrides,
});

const afterEvent = (command: string, overrides: Partial<HookEvent<'afterTool'>> = {}): HookEvent<'afterTool'> => ({
  cwd: '/tmp/ws',
  sessionId: 'sess-claude',
  toolInput: { command },
  toolName: 'Bash',
  toolResponse: { exit_code: 0, stdout: 'ok' },
  toolUseId: 'toolu_fast',
  transcriptPath: '/tmp/transcript.json',
  ...overrides,
});

/** Services that keep the real hook libraries away from the state directory and the daemon socket. */
const quietServices = (extra: HookServices = {}): HookServices & { readonly records: HookRecord[] } => {
  const records: HookRecord[] = [];
  return {
    haulerArgv: ['hauler'],
    probeDaemon: () => 'idle',
    record: (entry) => {
      records.push(entry);
    },
    recordAttempt: () => undefined,
    records,
    ...extra,
  };
};

const beforeHarness = (services: HookServices = quietServices()) => {
  let loads = 0;
  const written: Readonly<Record<string, unknown>>[] = [];
  const handler = createBeforeToolHandler({
    loadBeforeShell: async () => {
      loads += 1;
      return { handleBeforeShell };
    },
    services,
    writeOutput: (output) => {
      written.push(output);
    },
  });
  return { handler, loads: () => loads, written };
};

const finishedTicket = (ticket: string): FinishedTicket => ({
  error: null,
  errorCount: 0,
  exitCode: 0,
  status: 'done',
  ticket,
  warningCount: 0,
});

describe('tool/before fast path', () => {
  it('continues a non-cargo command without evaluating the rewrite module', async () => {
    const { handler, loads, written } = beforeHarness();
    const result = await handler(beforeEvent('ls -la'), contextFor('claude'));
    expect(result).toBeUndefined();
    expect(loads()).toBe(0);
    expect(written).toEqual([]);
  });

  it('continues a tool input without a command without evaluating anything', async () => {
    const { handler, loads } = beforeHarness();
    expect(await handler(beforeEvent(undefined), contextFor('claude'))).toBeUndefined();
    expect(await handler(beforeEvent('git status && pnpm test'), contextFor('cursor'))).toBeUndefined();
    expect(loads()).toBe(0);
  });

  it('writes the allow projection for a fully brokered cargo command on Claude', async () => {
    const { handler, loads, written } = beforeHarness();
    const result = await handler(beforeEvent('cargo test -p foo'), contextFor('claude'));
    expect(result).toBeUndefined();
    expect(loads()).toBe(1);
    expect(written).toEqual([
      {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          updatedInput: { command: 'hauler exec --session sess-claude --host claude -- cargo test -p foo' },
        },
      },
    ]);
  });

  it('writes Cursor its own allow shape, attributed to host cursor', async () => {
    const { handler, written } = beforeHarness();
    await handler(beforeEvent('cargo build', { sessionId: 'conv-2', toolName: 'Shell' }), contextFor('cursor'));
    expect(written).toEqual([
      {
        permission: 'allow',
        updated_input: { command: 'hauler exec --session conv-2 --host cursor -- cargo build' },
      },
    ]);
  });

  it('hands a rewrite beside an ungoverned segment to the framework as continue + updatedInput', async () => {
    const { handler, written } = beforeHarness();
    const result = await handler(beforeEvent('cargo test -p foo && rm -rf target'), contextFor('claude'));
    expect(result).toEqual({
      outcome: 'continue',
      updatedInput: { command: 'hauler exec --session sess-claude --host claude -- cargo test -p foo && rm -rf target' },
    });
    expect(written).toEqual([]);
  });

  it('evaluates the rewrite module for a hauler command and passes it through untouched', async () => {
    const { handler, loads, written } = beforeHarness();
    const result = await handler(
      beforeEvent('hauler exec --session sess-claude --host claude -- cargo check'),
      contextFor('claude'),
    );
    expect(result).toBeUndefined();
    expect(loads()).toBe(1);
    expect(written).toEqual([]);
    expect(await handler(beforeEvent('hauler status'), contextFor('claude'))).toBeUndefined();
  });

  it('continues when the command cannot be parsed', async () => {
    const { handler, written } = beforeHarness();
    expect(await handler(beforeEvent('cargo test &&'), contextFor('claude'))).toBeUndefined();
    expect(written).toEqual([]);
  });

  it('still denies cargo clean while the daemon has in-flight builds', async () => {
    const attempts: DeniedAttempt[] = [];
    const services = quietServices({
      probeDaemon: () => 'active',
      recordAttempt: (attempt) => {
        attempts.push(attempt);
      },
    });
    const { handler, written } = beforeHarness(services);
    const result = await handler(beforeEvent('cargo clean'), contextFor('claude'));
    expect(result).toEqual({
      outcome: 'deny',
      reason: expect.stringContaining('cargo clean is blocked'),
    });
    expect(written).toEqual([]);
    expect(services.records).toEqual([expect.objectContaining({ outcome: 'deny', phase: 'beforeTool' })]);
    expect(attempts).toEqual([expect.objectContaining({ argv: ['cargo', 'clean'], session: 'sess-claude' })]);
  });

  it('runs cargo clean raw when no daemon is listening', async () => {
    const { handler } = beforeHarness(quietServices({ probeDaemon: () => 'absent' }));
    expect(await handler(beforeEvent('cargo clean'), contextFor('claude'))).toBeUndefined();
  });
});

describe('projectBeforeShellResult', () => {
  const written: Readonly<Record<string, unknown>>[] = [];
  const write = (output: Readonly<Record<string, unknown>>): void => {
    written.push(output);
  };

  it('maps continue and deny onto the config-declared contract', () => {
    expect(projectBeforeShellResult({ outcome: 'continue' }, contextFor('claude'), write)).toBeUndefined();
    expect(projectBeforeShellResult({ outcome: 'deny', reason: 'busy' }, contextFor('claude'), write)).toEqual({
      outcome: 'deny',
      reason: 'busy',
    });
    // The wrapper rejects a denial without a reason; the hook never omits one.
    expect(projectBeforeShellResult({ outcome: 'deny' }, contextFor('cursor'), write)).toEqual({
      outcome: 'deny',
      reason: 'blocked by cargo-hauler',
    });
    expect(written).toEqual([]);
  });

  it('projects allow onto every host exactly as the event-route projector does', () => {
    const updatedInput = { command: 'hauler exec -- cargo build' };
    expect(allowOutput('claude', 'PreToolUse', updatedInput)).toEqual({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput },
    });
    expect(allowOutput('codex', 'PreToolUse', updatedInput)).toEqual({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput },
    });
    expect(allowOutput('cursor', 'preToolUse', updatedInput)).toEqual({ permission: 'allow', updated_input: updatedInput });
    expect(allowOutput('cursor', 'preToolUse', undefined)).toEqual({ permission: 'allow' });
    expect(projectBeforeShellResult({ outcome: 'allow', updatedInput }, contextFor('codex'), write)).toBeUndefined();
    expect(written).toEqual([
      { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput } },
    ]);
  });
});

describe('tool/after fast path', () => {
  const afterHarness = (ping: SessionCompletedPing, services: HookServices = {}) => {
    let loads = 0;
    const pings: { readonly session: string; readonly sinceMs: number }[] = [];
    const written: { readonly session: string; readonly atMs: number }[] = [];
    const records: HookRecord[] = [];
    const handler = createAfterToolHandler({
      loadAfterShell: async () => {
        loads += 1;
        return { handleAfterShell };
      },
      ping: async (session, sinceMs) => {
        pings.push({ session, sinceMs });
        return ping;
      },
      services: {
        nowMs: () => 1_000,
        readCursor: () => 42,
        record: (entry) => {
          records.push(entry);
        },
        writeCursor: (session, atMs) => {
          written.push({ atMs, session });
        },
        ...services,
      },
    });
    return { handler, loads: () => loads, pings, records, written };
  };

  it('pings the daemon with the hook-state cursor and continues when nothing finished', async () => {
    const { handler, loads, pings, written } = afterHarness({ kind: 'finished', tickets: [] });
    expect(await handler(afterEvent('ls -la'), afterContextFor('claude'))).toBeUndefined();
    expect(pings).toEqual([{ session: 'sess-claude', sinceMs: 42 }]);
    expect(loads()).toBe(0);
    expect(written).toEqual([]);
  });

  it('continues quietly when the daemon is unavailable', async () => {
    for (const ping of [
      { code: 'ECONNREFUSED', kind: 'unavailable', reason: 'unreachable' },
      { kind: 'unavailable', reason: 'timeout' },
      { kind: 'unavailable', reason: 'closed' },
      { kind: 'unavailable', reason: 'malformed' },
    ] as const satisfies readonly SessionCompletedPing[]) {
      const { handler, loads } = afterHarness(ping);
      expect(await handler(afterEvent('ls -la'), afterContextFor('cursor'))).toBeUndefined();
      expect(loads()).toBe(0);
    }
  });

  it('loads the rest of the hook and announces finished tickets from the ping, advancing the cursor', async () => {
    const { handler, loads, written } = afterHarness({
      kind: 'finished',
      tickets: [finishedTicket('cc-7'), { ...finishedTicket('cc-8'), errorCount: 2, exitCode: 101, status: 'failed' }],
    });
    const result = await handler(afterEvent('ls -la'), afterContextFor('claude'));
    expect(loads()).toBe(1);
    expect(result).toEqual({ additionalContext: expect.stringContaining('cc-7') });
    expect(result?.additionalContext).toContain('cc-8');
    expect(written).toEqual([{ atMs: 1_000, session: 'sess-claude' }]);
  });

  it('records a cargo command even when nothing finished, without a second daemon round trip', async () => {
    const { handler, loads, pings, records } = afterHarness({ kind: 'finished', tickets: [] });
    expect(await handler(afterEvent('cargo test -p foo'), afterContextFor('claude'))).toBeUndefined();
    expect(loads()).toBe(1);
    expect(pings).toHaveLength(1);
    expect(records).toEqual([
      expect.objectContaining({ command: 'cargo test -p foo', exitCode: 0, host: 'claude', phase: 'afterTool' }),
    ]);
  });

  it('skips the ping when the host names no session', async () => {
    const { handler, pings } = afterHarness({ kind: 'finished', tickets: [finishedTicket('cc-1')] });
    expect(await handler(afterEvent('ls -la', { sessionId: '' }), afterContextFor('claude'))).toBeUndefined();
    expect(pings).toEqual([]);
  });
});

describe('pingSessionCompleted', () => {
  const withServer = async (
    onLine: (line: string, socket: Socket) => void,
    body: (socketPath: string, received: string[]) => Promise<void>,
  ): Promise<void> => {
    const root = mkdtempSync(join(tmpdir(), 'hauler-ping-'));
    const socketPath = join(root, 'daemon.sock');
    const received: string[] = [];
    const server: Server = createServer((socket) => {
      let pending = '';
      socket.setEncoding('utf8');
      socket.on('data', (chunk: string) => {
        pending += chunk;
        let newline = pending.indexOf('\n');
        while (newline !== -1) {
          const line = pending.slice(0, newline);
          pending = pending.slice(newline + 1);
          received.push(line);
          onLine(line, socket);
          newline = pending.indexOf('\n');
        }
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(socketPath, resolve);
    });
    try {
      await body(socketPath, received);
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      rmSync(root, { force: true, recursive: true });
    }
  };

  it('sends the session-completed request and reads the finished tickets', async () => {
    await withServer(
      (_line, socket) => {
        socket.write(
          `${JSON.stringify({
            id: 'hook-completed',
            requests: [
              { error: null, errorCount: 0, exitCode: 0, status: 'done', ticket: 'cc-3', warningCount: 1 },
              { status: 'queued', ticket: 'cc-4' },
              'not a ticket',
            ],
            type: 'session-completed-result',
          })}\n`,
        );
      },
      async (socketPath, received) => {
        const ping = await pingSessionCompleted('sess-ping', 1234, { socketPath, timeoutMs: 500 });
        expect(ping).toEqual({
          kind: 'finished',
          tickets: [{ error: null, errorCount: 0, exitCode: 0, status: 'done', ticket: 'cc-3', warningCount: 1 }],
        });
        expect(received.map((line) => JSON.parse(line) as unknown)).toEqual([
          { id: 'hook-completed', session: 'sess-ping', sinceMs: 1234, type: 'session-completed' },
        ]);
      },
    );
  });

  it('reports a reply that is not a session-completed-result as malformed', async () => {
    await withServer(
      (_line, socket) => {
        socket.write(`${JSON.stringify({ type: 'error', message: 'unknown request' })}\n`);
      },
      async (socketPath) => {
        expect(await pingSessionCompleted('sess-ping', 0, { socketPath })).toEqual({
          kind: 'unavailable',
          reason: 'malformed',
        });
      },
    );
  });

  it('gives up within the budget when the daemon accepts but never answers', async () => {
    await withServer(
      () => undefined,
      async (socketPath) => {
        const startedAt = performance.now();
        expect(await pingSessionCompleted('sess-ping', 0, { socketPath, timeoutMs: 100 })).toEqual({
          kind: 'unavailable',
          reason: 'timeout',
        });
        expect(performance.now() - startedAt).toBeLessThan(2_000);
      },
    );
  });

  it('reports a daemon that hangs up before answering as closed', async () => {
    await withServer(
      (_line, socket) => {
        socket.end();
      },
      async (socketPath) => {
        expect(await pingSessionCompleted('sess-ping', 0, { socketPath })).toEqual({
          kind: 'unavailable',
          reason: 'closed',
        });
      },
    );
  });

  it('is unreachable, fast and silent, when nothing listens on the socket path', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hauler-ping-none-'));
    try {
      const startedAt = performance.now();
      const ping = await pingSessionCompleted('sess-ping', 0, { socketPath: join(root, 'missing.sock') });
      expect(ping).toEqual({ code: 'ENOENT', kind: 'unavailable', reason: 'unreachable' });
      expect(performance.now() - startedAt).toBeLessThan(1_000);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it.live('speaks the running daemon protocol and feeds the after-tool hook its finished tickets', () =>
    Effect.gen(function* () {
      const fixture = yield* scopedDaemon(1);
      const session = 'sess-live-ping';
      // Only a background ticket reaches the agent through session-completed;
      // a streamed one already delivered its exit to the waiting client.
      const submitted = yield* runExecClient({
        argv: ['cargo', 'check'],
        autoSpawn: false,
        background: true,
        config: fixture.config,
        cwd: fixture.ws1,
        env: fakeCargoEnv(fixture),
        host: 'claude',
        io: { writeStderr: () => undefined, writeStdout: () => undefined },
        session,
      });
      expect(submitted.ticket).toMatch(/^cc-\d+$/u);
      yield* pollReport(fixture, (report) =>
        report.recent.some((request) => request.ticket === submitted.ticket && request.status === 'done'),
      );
      const socketPath = fixture.config.socketPath;

      const pinged = yield* Effect.promise(() => pingSessionCompleted(session, 0, { socketPath }));
      expect(pinged).toEqual({
        kind: 'finished',
        tickets: [expect.objectContaining({ exitCode: 0, status: 'done' })],
      });
      // Another session sees nothing; the ledger answers per session.
      expect(yield* Effect.promise(() => pingSessionCompleted('sess-other', 0, { socketPath }))).toEqual({
        kind: 'finished',
        tickets: [],
      });

      // The whole hook, wired to the live daemon: a non-cargo `ls` in the
      // session that ran cargo learns its ticket finished and moves the cursor.
      const written: number[] = [];
      const handler = createAfterToolHandler({
        loadAfterShell: async () => ({ handleAfterShell }),
        ping: (target, sinceMs) => pingSessionCompleted(target, sinceMs, { socketPath }),
        services: {
          nowMs: () => 7_000,
          readCursor: () => 0,
          record: () => undefined,
          writeCursor: (_session, atMs) => {
            written.push(atMs);
          },
        },
      });
      const result = yield* Effect.promise(async () =>
        handler(afterEvent('ls -la', { cwd: fixture.ws1, sessionId: session }), afterContextFor('claude')),
      );
      expect(result?.additionalContext).toContain('finished: success');
      expect(written).toEqual([7_000]);
    }), 20_000);
});
