import {
  ServeAppCommandError,
  spawnServeApp,
  type ServeAppExit,
  type SpawnedServeApp,
  type SpawnServeAppOptions,
} from 'agent-bundle/serve-app-command';

/** Where this install keeps its built host packs; `undefined` when it has none (npm package, installed host pack). */
export interface DashboardProject {
  readonly artifact: string;
  readonly root: string;
}

export interface DashboardServeInput {
  readonly noOpen?: boolean | undefined;
  readonly port?: number | undefined;
  readonly target?: 'claude' | 'codex' | 'cursor' | 'portable' | undefined;
}

export interface DashboardServeResult {
  readonly exitCode: number;
  readonly message: string;
  readonly operation: 'dashboard';
  /** The served host page, once `agent-bundle serve-app` printed its ready line. */
  readonly url: string | null;
}

export interface DashboardServeOptions {
  readonly input: DashboardServeInput;
  readonly project: DashboardProject | undefined;
  readonly signal: AbortSignal;
  /** Injectable only to make the framework process deterministic in tests. */
  readonly spawn?: (options: SpawnServeAppOptions) => Promise<SpawnedServeApp>;
}

const inHost = 'In an MCP host, call hauler_status instead — the dashboard App is attached to its result.';

const failure = (exitCode: number, message: string): DashboardServeResult => ({
  exitCode,
  message,
  operation: 'dashboard',
  url: null,
});

/** The child's exit as this command's: its code, or 1 for an exit with neither code nor signal, or 128 for a signal. */
const exitCodeOf = ({ code, signal }: ServeAppExit): number => code ?? (signal === null ? 1 : 128);

/**
 * After the ready line the App is the caller's. Exactly one party sends the
 * server its SIGTERM — a second one can bypass a one-shot graceful handler in
 * the child — and only `close()` reports a refused signal, so the request
 * `signal` is not handed to the helper past readiness (see `serveDashboard`);
 * here an abort means one `close()`, whose exit settles this or whose
 * `stop-failed` rejects it instead of leaving `closed` pending for ever.
 */
const exitOrStopFailure = (served: SpawnedServeApp, signal: AbortSignal): Promise<ServeAppExit> =>
  new Promise<ServeAppExit>((settle, reject) => {
    const onAbort = (): void => {
      served.close().then(settle, reject);
    };
    void served.closed.then((exit) => {
      signal.removeEventListener('abort', onAbort);
      settle(exit);
    });
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });

/**
 * A signal for the helper that follows the request `signal` only until the
 * ready line: before it the helper owns the child and an abort is its
 * `aborted` / `stop-failed` rejection; after it `exitOrStopFailure` owns the
 * one stop. Returns the signal and the hand-over that stops following.
 */
const untilReady = (signal: AbortSignal): { readonly signal: AbortSignal; readonly handOver: () => void } => {
  const controller = new AbortController();
  const follow = (): void => {
    controller.abort();
  };
  if (signal.aborted) {
    follow();
  } else {
    signal.addEventListener('abort', follow, { once: true });
  }
  return {
    signal: controller.signal,
    handOver: () => {
      signal.removeEventListener('abort', follow);
    },
  };
};

/**
 * Serves `hauler/dashboard` through `agent-bundle serve-app` against the
 * install's built artifact and stays until the server exits or `signal`
 * aborts; every `ServeAppCommandError` becomes the command's result.
 */
export const serveDashboard = async ({
  input,
  project,
  signal,
  spawn = spawnServeApp,
}: DashboardServeOptions): Promise<DashboardServeResult> => {
  if (project === undefined) {
    return failure(
      1,
      `hauler dashboard runs from the plugin checkout, where the built artifact sits beside the CLI; an installed host pack has none. ${inHost}`,
    );
  }
  const helper = untilReady(signal);
  let served: SpawnedServeApp;
  try {
    served = await spawn({
      app: 'hauler/dashboard',
      root: project.root,
      artifact: project.artifact,
      target: input.target ?? 'portable',
      tool: 'hauler_status',
      autoApprove: ['call-tool'],
      open: input.noOpen !== true,
      ...(input.port === undefined ? {} : { port: input.port }),
      // Ctrl-C reaching the routed CLI before the ready line stops the server.
      signal: helper.signal,
    });
  } catch (error) {
    helper.handOver();
    if (error instanceof ServeAppCommandError) {
      // framework-not-installed, artifact-missing, exited-before-ready (with
      // the child's exit), spawn-failed, aborted, stop-failed.
      return failure(error.exit === undefined ? 1 : exitCodeOf(error.exit), `${error.message} ${inHost}`);
    }
    throw error;
  }
  helper.handOver();
  let exit: ServeAppExit;
  try {
    // `helper.signal` aborted and yet the App was served: the abort came
    // before the ready line, the helper's SIGTERM was accepted (a refusal
    // rejects `spawn` with `stop-failed`), and the child printed its ready
    // line while dying. Its exit is on the way; a `close()` would be a second
    // SIGTERM. An abort cannot land between the ready line and this point:
    // the ready line settles `spawn` from a stdout event and this continuation
    // runs in the microtasks after it, before any signal handler or timer.
    exit = helper.signal.aborted ? await served.closed : await exitOrStopFailure(served, signal);
  } catch (error) {
    if (error instanceof ServeAppCommandError) {
      return { ...failure(1, `${error.message} Stop it by hand (kill ${String(served.pid)}).`), url: served.url };
    }
    throw error;
  }
  return {
    exitCode: exitCodeOf(exit),
    message:
      exit.code === 0
        ? 'dashboard closed'
        : `agent-bundle serve-app exited with ${exit.signal ?? String(exit.code)}; see its diagnostics above`,
    operation: 'dashboard',
    url: served.url,
  };
};
