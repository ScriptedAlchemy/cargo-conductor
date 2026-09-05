import type { HookHandler, HookHandlerContext, HookResult } from 'agent-bundle/config';

import { extractShellCommand } from '../../lib/tool-input.js';
import type { BeforeShellResult, HookServices, handleBeforeShell } from '../before-shell.js';

import { allowOutput, jsonObjectOf } from './allow-output.js';
import { commandMentionsHauler } from './tokens.js';

/**
 * What the `tool/before` hook entry needs behind its fast path. `loadBeforeShell`
 * is the deferred import of the rewrite machinery (bash parser, daemon probe,
 * telemetry); tests hand in a spy to prove a non-cargo command never calls it.
 */
export interface BeforeToolFastPath {
  readonly loadBeforeShell: () => Promise<{ readonly handleBeforeShell: typeof handleBeforeShell }>;
  readonly services?: HookServices;
  /** Where the one in-plugin projection (`allow`) is written; stdout in the hook process. */
  readonly writeOutput?: (output: Readonly<Record<string, unknown>>) => void;
}

const writeStdout = (output: Readonly<Record<string, unknown>>): void => {
  process.stdout.write(JSON.stringify(output));
};

const fallbackDenyReason = 'blocked by cargo-hauler';

/**
 * Hands a `BeforeShellResult` to the generated wrapper wherever its contract
 * can carry it — `continue` (with or without the rewritten input) and `deny`
 * — and writes the one decision it cannot, `allow`, in the host's own shape.
 * Returning `undefined` after writing keeps the wrapper silent, so the host
 * reads exactly one JSON value.
 */
export const projectBeforeShellResult = (
  result: BeforeShellResult,
  context: Pick<HookHandlerContext, 'nativeEvent' | 'target'>,
  writeOutput: (output: Readonly<Record<string, unknown>>) => void,
): HookResult<'beforeTool'> | undefined => {
  const updatedInput = result.updatedInput === undefined ? undefined : jsonObjectOf(result.updatedInput);
  switch (result.outcome) {
    case 'continue':
      return updatedInput === undefined ? undefined : { outcome: 'continue', updatedInput };
    case 'deny':
      return {
        outcome: 'deny',
        reason: result.reason === undefined || result.reason.length === 0 ? fallbackDenyReason : result.reason,
      };
    case 'allow':
      writeOutput(allowOutput(context.target, context.nativeEvent, updatedInput));
      return undefined;
    default: {
      const exhaustive: never = result.outcome;
      return exhaustive;
    }
  }
};

/**
 * The `tool/before` hook entry every host pack registers for its shell tool
 * (`hooks.beforeTool` in `agent-bundle.config.ts`). It decides on the raw
 * command string first: a command that names neither cargo, hauler, nor
 * conductor is `continue` — no decision, the host's own flow — before the
 * rewrite machinery is even evaluated. Everything else is the same
 * `handleBeforeShell` the event route used to call: the rewrite onto
 * `hauler exec`, the `cargo clean` guard, the telemetry record.
 */
export const createBeforeToolHandler = (fastPath: BeforeToolFastPath): HookHandler<'beforeTool'> => {
  const writeOutput = fastPath.writeOutput ?? writeStdout;
  return async (event, context) => {
    if (!commandMentionsHauler(extractShellCommand(event.toolInput))) {
      return undefined;
    }
    const { handleBeforeShell } = await fastPath.loadBeforeShell();
    const result = await handleBeforeShell(
      event,
      { nativeEvent: context.nativeEvent, target: context.target },
      fastPath.services,
    );
    return projectBeforeShellResult(result, context, writeOutput);
  };
};

export default createBeforeToolHandler({
  // Deliberate dynamic import (the documented exception to top-level imports):
  // deferring `before-shell.ts` keeps the bash parser, the daemon probe, and
  // the telemetry writer out of the work every shell tool call does. The
  // build inlines the module into this entry rather than emitting a chunk, so
  // its declarations are still parsed at startup (~140 KB, a few ms); the
  // token test above is what keeps a non-cargo call from running any of it.
  loadBeforeShell: () => import('../before-shell.js'),
});
