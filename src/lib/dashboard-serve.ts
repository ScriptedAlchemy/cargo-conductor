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
 * After the ready line the App is the caller's: the helper's own abort
 * handler sends SIGTERM but reports a refused signal only through `close()`,
 * so an abort whose stop failed would otherwise leave `closed` pending for
 * ever. This settles with the exit, or rejects with that `stop-failed`.
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
      // Ctrl-C reaching the routed CLI stops the server.
      signal,
    });
  } catch (error) {
    if (error instanceof ServeAppCommandError) {
      // framework-not-installed, artifact-missing, exited-before-ready (with
      // the child's exit), spawn-failed, aborted, stop-failed.
      return failure(error.exit === undefined ? 1 : exitCodeOf(error.exit), `${error.message} ${inHost}`);
    }
    throw error;
  }
  let exit: ServeAppExit;
  try {
    exit = await exitOrStopFailure(served, signal);
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
