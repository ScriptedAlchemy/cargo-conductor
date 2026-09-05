import { describe, expect, it } from 'effect-rstest';
import {
  ServeAppCommandError,
  type ServeAppExit,
  type SpawnedServeApp,
  type SpawnServeAppOptions,
} from 'agent-bundle/serve-app-command';

import { serveDashboard, type DashboardServeOptions } from '../src/lib/dashboard-serve.js';

const project = { artifact: '/checkout/artifact', root: '/checkout' };

interface FakeServer {
  readonly served: SpawnedServeApp;
  readonly exit: (exit: ServeAppExit) => void;
  readonly closeCalls: () => number;
}

const fakeServer = (options: { readonly closeRejects?: ServeAppCommandError } = {}): FakeServer => {
  let settle: (exit: ServeAppExit) => void = () => undefined;
  const closed = new Promise<ServeAppExit>((resolveClosed) => {
    settle = resolveClosed;
  });
  let closeCalls = 0;
  const served: SpawnedServeApp = {
    app: 'hauler/dashboard',
    tool: 'hauler_status',
    url: 'http://127.0.0.1:40577/',
    server: 'hauler',
    port: 40_577,
    pid: 4242,
    closed,
    close: () => {
      closeCalls += 1;
      if (options.closeRejects !== undefined) {
        return Promise.reject(options.closeRejects);
      }
      settle({ code: null, signal: 'SIGTERM' });
      return closed;
    },
  };
  return { served, exit: settle, closeCalls: () => closeCalls };
};

const serve = (
  overrides: Partial<DashboardServeOptions> & Pick<DashboardServeOptions, 'spawn'>,
): ReturnType<typeof serveDashboard> =>
  serveDashboard({
    input: {},
    project,
    signal: new AbortController().signal,
    ...overrides,
  });

describe('serveDashboard', () => {
  it('refuses without a located artifact and points at hauler_status in a host', async () => {
    let spawned = false;
    const result = await serve({
      project: undefined,
      spawn: () => {
        spawned = true;
        return Promise.reject(new Error('unreachable'));
      },
    });
    expect(spawned).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.url).toBeNull();
    expect(result.message).toContain('plugin checkout');
    expect(result.message).toContain('call hauler_status instead');
  });

  it('passes the App, artifact, opening tool, approval, and flags through to spawnServeApp', async () => {
    let seen: SpawnServeAppOptions | undefined;
    const controller = new AbortController();
    const server = fakeServer();
    const pending = serve({
      input: { noOpen: true, port: 4321, target: 'cursor' },
      signal: controller.signal,
      spawn: (options) => {
        seen = options;
        return Promise.resolve(server.served);
      },
    });
    server.exit({ code: 0, signal: null });
    const result = await pending;
    expect(seen).toEqual({
      app: 'hauler/dashboard',
      root: '/checkout',
      artifact: '/checkout/artifact',
      target: 'cursor',
      tool: 'hauler_status',
      autoApprove: ['call-tool'],
      open: false,
      port: 4321,
      signal: controller.signal,
    });
    expect(result).toEqual({
      exitCode: 0,
      message: 'dashboard closed',
      operation: 'dashboard',
      url: 'http://127.0.0.1:40577/',
    });
  });

  it('defaults to the portable pack, an ephemeral port, and opening the browser', async () => {
    let seen: SpawnServeAppOptions | undefined;
    const server = fakeServer();
    const pending = serve({
      spawn: (options) => {
        seen = options;
        return Promise.resolve(server.served);
      },
    });
    server.exit({ code: 0, signal: null });
    await pending;
    expect(seen?.target).toBe('portable');
    expect(seen?.open).toBe(true);
    expect(seen).not.toHaveProperty('port');
  });

  it.each([
    ['framework-not-installed', undefined, 1],
    ['artifact-missing', undefined, 1],
    ['spawn-failed', undefined, 1],
    ['aborted', undefined, 1],
    ['exited-before-ready', { code: 3, signal: null }, 3],
    ['exited-before-ready', { code: null, signal: 'SIGKILL' }, 128],
  ] as const)('maps a %s failure before the ready line onto the result (exit %s)', async (code, exit, exitCode) => {
    const error = new ServeAppCommandError(code, `${code} happened.`, exit === undefined ? {} : { exit });
    const result = await serve({ spawn: () => Promise.reject(error) });
    expect(result).toEqual({
      exitCode,
      message: expect.stringContaining(`${code} happened. In an MCP host, call hauler_status instead`),
      operation: 'dashboard',
      url: null,
    });
  });

  it('rethrows an unexpected spawn error instead of masking it as a result', async () => {
    await expect(serve({ spawn: () => Promise.reject(new TypeError('bad option')) })).rejects.toThrow('bad option');
  });

  it('reports a server that exited on its own with its code or signal', async () => {
    const byCode = fakeServer();
    const codePending = serve({ spawn: () => Promise.resolve(byCode.served) });
    byCode.exit({ code: 2, signal: null });
    expect(await codePending).toMatchObject({ exitCode: 2, message: expect.stringContaining('exited with 2') });

    const bySignal = fakeServer();
    const signalPending = serve({ spawn: () => Promise.resolve(bySignal.served) });
    bySignal.exit({ code: null, signal: 'SIGTERM' });
    expect(await signalPending).toMatchObject({
      exitCode: 128,
      message: expect.stringContaining('exited with SIGTERM'),
      url: 'http://127.0.0.1:40577/',
    });
  });

  it('closes the served App when the request aborts and returns its exit', async () => {
    const controller = new AbortController();
    const server = fakeServer();
    const pending = serve({ signal: controller.signal, spawn: () => Promise.resolve(server.served) });
    controller.abort();
    const result = await pending;
    expect(server.closeCalls()).toBe(1);
    expect(result.exitCode).toBe(128);
  });

  it('does not hang when the abort cannot stop the server: the stop failure is the result', async () => {
    const controller = new AbortController();
    const stopFailed = new ServeAppCommandError(
      'stop-failed',
      'agent-bundle serve-app (pid 4242) could not be signalled to stop and is still running.',
    );
    const server = fakeServer({ closeRejects: stopFailed });
    const pending = serve({ signal: controller.signal, spawn: () => Promise.resolve(server.served) });
    controller.abort();
    const result = await pending;
    expect(server.closeCalls()).toBe(1);
    expect(result).toEqual({
      exitCode: 1,
      message: expect.stringContaining('could not be signalled to stop and is still running. Stop it by hand (kill 4242).'),
      operation: 'dashboard',
      url: 'http://127.0.0.1:40577/',
    });
  });

  it('settles on the abort even when the signal was already aborted after the ready line', async () => {
    const controller = new AbortController();
    const server = fakeServer();
    controller.abort();
    // The helper itself rejects a pre-aborted spawn; here the fake served it,
    // so the caller's own abort handling must still close it.
    const result = await serve({ signal: controller.signal, spawn: () => Promise.resolve(server.served) });
    expect(server.closeCalls()).toBe(1);
    expect(result.exitCode).toBe(128);
  });
});
