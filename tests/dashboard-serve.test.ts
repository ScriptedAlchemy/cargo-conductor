import { describe, expect, it } from 'effect-rstest';
import {
  ServeAppCommandError,
  type ServeAppExit,
  type SpawnedServeApp,
  type SpawnServeAppOptions,
} from 'agent-bundle/serve-app-command';

import { serveDashboard, type DashboardServeOptions } from '../src/lib/dashboard-serve.js';

const project = { artifact: '/checkout/artifact', root: '/checkout' };

interface FakeHelper {
  /** Stands in for `spawnServeApp`; records the options it was given. */
  readonly spawn: (options: SpawnServeAppOptions) => Promise<SpawnedServeApp>;
  readonly options: () => SpawnServeAppOptions | undefined;
  /** How many SIGTERMs the fake child received — from the helper's own abort listener or from `close()`. */
  readonly stops: () => number;
  /** The child exits on its own. */
  readonly exit: (exit: ServeAppExit) => void;
  /** Print the ready line: `spawn` resolves. */
  readonly ready: () => void;
}

/**
 * Mirrors the real helper's contract: an abort of `options.signal` sends the
 * child a SIGTERM — rejecting `spawn` with `aborted` before the ready line,
 * settling `closed` after it — and `close()` sends one too, resolving with
 * the exit or rejecting with `stop-failed` when the child refuses it.
 */
const fakeHelper = (
  behaviour: {
    readonly refuseStop?: boolean;
    readonly readyAtOnce?: boolean;
    /** The child prints its ready line while dying from the pre-ready stop: `spawn` resolves although the signal aborted. */
    readonly readyWhileDying?: boolean;
  } = {},
): FakeHelper => {
  let seen: SpawnServeAppOptions | undefined;
  let stops = 0;
  let settledExit: ServeAppExit | undefined;
  let settleClosed: (exit: ServeAppExit) => void = () => undefined;
  const closed = new Promise<ServeAppExit>((resolveClosed) => {
    settleClosed = resolveClosed;
  });
  let announceReady: () => void = () => undefined;
  let rejectSpawn: (error: unknown) => void = () => undefined;
  const finish = (exit: ServeAppExit): void => {
    if (settledExit !== undefined) return;
    settledExit = exit;
    settleClosed(exit);
  };
  const stopFailure = (): ServeAppCommandError =>
    new ServeAppCommandError('stop-failed', 'agent-bundle serve-app (pid 4242) could not be signalled to stop and is still running.');
  const stop = (): ServeAppCommandError | undefined => {
    if (settledExit !== undefined) return undefined;
    stops += 1;
    if (behaviour.refuseStop === true) return stopFailure();
    finish({ code: null, signal: 'SIGTERM' });
    return undefined;
  };
  const served: SpawnedServeApp = {
    app: 'hauler/dashboard',
    tool: 'hauler_status',
    url: 'http://127.0.0.1:40577/',
    server: 'hauler',
    port: 40_577,
    pid: 4242,
    closed,
    close: () => {
      const refused = stop();
      return refused === undefined ? closed : Promise.reject(refused);
    },
  };
  return {
    spawn: (options) => {
      seen = options;
      if (options.signal?.aborted === true) {
        // The real helper checks this before spawning anything.
        return Promise.reject(new ServeAppCommandError('aborted', 'Serving hauler/dashboard was aborted before agent-bundle serve-app started.'));
      }
      return new Promise<SpawnedServeApp>((settle, reject) => {
        let ready = false;
        rejectSpawn = reject;
        announceReady = () => {
          ready = true;
          settle(served);
        };
        options.signal?.addEventListener(
          'abort',
          () => {
            const refused = stop();
            if (ready) return;
            if (refused === undefined && behaviour.readyWhileDying === true) {
              announceReady();
              return;
            }
            reject(refused ?? new ServeAppCommandError('aborted', 'Serving hauler/dashboard was aborted before agent-bundle serve-app was ready.'));
          },
          { once: true },
        );
        if (behaviour.readyAtOnce !== false) announceReady();
      });
    },
    options: () => seen,
    stops: () => stops,
    exit: finish,
    ready: () => {
      announceReady();
      rejectSpawn = () => undefined;
    },
  };
};

const serve = (overrides: Partial<DashboardServeOptions> & Pick<DashboardServeOptions, 'spawn'>): ReturnType<typeof serveDashboard> =>
  serveDashboard({
    input: {},
    project,
    signal: new AbortController().signal,
    ...overrides,
  });

const settled = (): Promise<void> => new Promise((resolveTick) => setTimeout(resolveTick, 0));

describe('serveDashboard', () => {
  it('refuses without a located artifact and points at hauler_status in a host', async () => {
    const helper = fakeHelper();
    const result = await serve({ project: undefined, spawn: helper.spawn });
    expect(helper.options()).toBeUndefined();
    expect(result.exitCode).toBe(1);
    expect(result.url).toBeNull();
    expect(result.message).toContain('plugin checkout');
    expect(result.message).toContain('call hauler_status instead');
  });

  it('passes the App, artifact, opening tool, approval, and flags through to spawnServeApp', async () => {
    const helper = fakeHelper();
    const pending = serve({ input: { noOpen: true, port: 4321, target: 'cursor' }, spawn: helper.spawn });
    helper.exit({ code: 0, signal: null });
    const result = await pending;
    expect(helper.options()).toEqual({
      app: 'hauler/dashboard',
      root: '/checkout',
      artifact: '/checkout/artifact',
      target: 'cursor',
      tool: 'hauler_status',
      autoApprove: ['call-tool'],
      open: false,
      port: 4321,
      signal: expect.any(AbortSignal),
    });
    expect(result).toEqual({
      exitCode: 0,
      message: 'dashboard closed',
      operation: 'dashboard',
      url: 'http://127.0.0.1:40577/',
    });
  });

  it('defaults to the portable pack, an ephemeral port, and opening the browser', async () => {
    const helper = fakeHelper();
    const pending = serve({ spawn: helper.spawn });
    helper.exit({ code: 0, signal: null });
    await pending;
    expect(helper.options()?.target).toBe('portable');
    expect(helper.options()?.open).toBe(true);
    expect(helper.options()).not.toHaveProperty('port');
  });

  it.each([
    ['framework-not-installed', undefined, 1],
    ['artifact-missing', undefined, 1],
    ['spawn-failed', undefined, 1],
    ['aborted', undefined, 1],
    ['stop-failed', undefined, 1],
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
    const byCode = fakeHelper();
    const codePending = serve({ spawn: byCode.spawn });
    byCode.exit({ code: 2, signal: null });
    expect(await codePending).toMatchObject({ exitCode: 2, message: expect.stringContaining('exited with 2') });

    const bySignal = fakeHelper();
    const signalPending = serve({ spawn: bySignal.spawn });
    bySignal.exit({ code: null, signal: 'SIGTERM' });
    expect(await signalPending).toMatchObject({
      exitCode: 128,
      message: expect.stringContaining('exited with SIGTERM'),
      url: 'http://127.0.0.1:40577/',
    });
    expect(byCode.stops() + bySignal.stops()).toBe(0);
  });

  it('an abort before the ready line reaches the helper, which stops the child once', async () => {
    const controller = new AbortController();
    const helper = fakeHelper({ readyAtOnce: false });
    const pending = serve({ signal: controller.signal, spawn: helper.spawn });
    await settled();
    controller.abort();
    const result = await pending;
    expect(helper.stops()).toBe(1);
    expect(result).toMatchObject({ exitCode: 1, url: null, message: expect.stringContaining('aborted before agent-bundle serve-app was ready') });
  });

  it('an abort after the ready line stops the server exactly once and returns its exit', async () => {
    const controller = new AbortController();
    const helper = fakeHelper();
    const pending = serve({ signal: controller.signal, spawn: helper.spawn });
    await settled();
    controller.abort();
    const result = await pending;
    expect(helper.stops()).toBe(1);
    expect(result).toMatchObject({ exitCode: 128, message: expect.stringContaining('exited with SIGTERM'), url: 'http://127.0.0.1:40577/' });
  });

  it('does not hang when the abort cannot stop the server: the stop failure is the result', async () => {
    const controller = new AbortController();
    const helper = fakeHelper({ refuseStop: true });
    const pending = serve({ signal: controller.signal, spawn: helper.spawn });
    await settled();
    controller.abort();
    const result = await pending;
    expect(helper.stops()).toBe(1);
    expect(result).toEqual({
      exitCode: 1,
      message: expect.stringContaining('could not be signalled to stop and is still running. Stop it by hand (kill 4242).'),
      operation: 'dashboard',
      url: 'http://127.0.0.1:40577/',
    });
  });

  it('a pre-ready abort whose stop was accepted, with the ready line racing in, is not stopped again', async () => {
    const controller = new AbortController();
    const helper = fakeHelper({ readyAtOnce: false, readyWhileDying: true });
    const pending = serve({ signal: controller.signal, spawn: helper.spawn });
    await settled();
    controller.abort();
    const result = await pending;
    expect(helper.stops()).toBe(1);
    expect(result).toMatchObject({ exitCode: 128, message: expect.stringContaining('exited with SIGTERM'), url: 'http://127.0.0.1:40577/' });
  });

  it('a pre-ready abort whose stop was refused is the stop-failed result, not a hang', async () => {
    const controller = new AbortController();
    const helper = fakeHelper({ readyAtOnce: false, refuseStop: true });
    const pending = serve({ signal: controller.signal, spawn: helper.spawn });
    await settled();
    controller.abort();
    const result = await pending;
    expect(helper.stops()).toBe(1);
    expect(result).toMatchObject({ exitCode: 1, url: null, message: expect.stringContaining('could not be signalled to stop') });
  });

  it('a signal aborted before the spawn is handed to the helper, which rejects it', async () => {
    const controller = new AbortController();
    controller.abort();
    const helper = fakeHelper({ readyAtOnce: false });
    const result = await serve({ signal: controller.signal, spawn: helper.spawn });
    expect(helper.options()?.signal?.aborted).toBe(true);
    expect(helper.stops()).toBe(0);
    expect(result).toMatchObject({ exitCode: 1, url: null, message: expect.stringContaining('aborted before agent-bundle serve-app started') });
  });

  it('a server that exits on its own after an abort was handled is not stopped again', async () => {
    const controller = new AbortController();
    const helper = fakeHelper();
    const pending = serve({ signal: controller.signal, spawn: helper.spawn });
    await settled();
    helper.exit({ code: 0, signal: null });
    await settled();
    controller.abort();
    const result = await pending;
    expect(helper.stops()).toBe(0);
    expect(result.exitCode).toBe(0);
  });
});
