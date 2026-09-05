import type { HookHandler } from 'agent-bundle/config';

import { extractShellCommand } from '../../lib/tool-input.js';
import type { handleAfterShell } from '../after-shell.js';
import type { FinishedTicket } from '../finished-ticket.js';
import { readCursor } from '../hook-state.js';
import type { HookServices } from '../shared.js';

import { pingSessionCompleted } from './session-ping.js';
import { commandMentionsHauler } from './tokens.js';

/**
 * What the `tool/after` hook entry needs behind its fast path. `loadAfterShell`
 * is the deferred import of the telemetry and context formatting; `ping` is
 * the socket ping every call makes; tests replace both.
 */
export interface AfterToolFastPath {
  readonly loadAfterShell: () => Promise<{ readonly handleAfterShell: typeof handleAfterShell }>;
  readonly ping?: typeof pingSessionCompleted;
  readonly services?: HookServices;
}

/**
 * The `tool/after` hook entry every host pack registers for its shell tool
 * (`hooks.afterTool` in `agent-bundle.config.ts`). Every call still tells the
 * daemon the session is at a tool boundary — one `session-completed` ping
 * with the session's hook-state cursor, the smallest client there is — so a
 * finished background ticket is announced on the very next tool call, as
 * before. The rest of the hook (the telemetry record for cargo/hauler
 * commands, the formatted context) is evaluated only when the daemon reports
 * finished tickets or the command itself names cargo or hauler;
 * a plain `ls -la` with nothing finished is `continue` right here. A daemon
 * that is down or slow answers `unavailable`, which is `continue` too:
 * quiet, and within the same 500 ms budget the hook has always used.
 */
export const createAfterToolHandler = (fastPath: AfterToolFastPath): HookHandler<'afterTool'> => {
  const ping = fastPath.ping ?? pingSessionCompleted;
  const cursorOf = fastPath.services?.readCursor ?? readCursor;
  return async (event, context) => {
    const related = commandMentionsHauler(extractShellCommand(event.toolInput));
    const session = event.sessionId;
    let finished: readonly FinishedTicket[] = [];
    if (session.length > 0) {
      const pinged = await ping(session, cursorOf(session));
      if (pinged.kind === 'finished') {
        finished = pinged.tickets;
      }
    }
    if (!related && finished.length === 0) {
      return undefined;
    }
    const { handleAfterShell } = await fastPath.loadAfterShell();
    const result = await handleAfterShell(
      event,
      { nativeEvent: context.nativeEvent, target: context.target },
      {
        ...fastPath.services,
        // The ping already asked the daemon; hand its answer over instead of
        // asking again. An empty answer leaves the cursor untouched.
        completedSince: async () => finished,
      },
    );
    return result.additionalContext === undefined ? undefined : { additionalContext: result.additionalContext };
  };
};

export default createAfterToolHandler({
  // Deliberate dynamic import (the documented exception to top-level imports):
  // deferring `after-shell.ts` keeps the telemetry writer and the ticket
  // formatter out of the work every shell tool call does. The build inlines
  // the module into this entry rather than emitting a chunk, so its
  // declarations are still parsed at startup (~50 KB in all); the ping and the
  // token test above are what keep a quiet call from running any of it.
  loadAfterShell: () => import('../after-shell.js'),
});
