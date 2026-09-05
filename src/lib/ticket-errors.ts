import * as Cause from 'effect/Cause';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Option from 'effect/Option';

import type { TicketSocketError } from '../client/tickets.js';

export const infraFailure = (error: TicketSocketError): Error => {
  switch (error._tag) {
    case 'DaemonUnreachable':
      return new Error(
        `hauler daemon unreachable at ${error.socketPath}; it starts on demand with any exec, or run: hauler daemon start`,
      );
    case 'ControlTimeout':
      return new Error(
        `hauler daemon did not answer within ${error.timeoutMs}ms (socket ${error.socketPath})`,
      );
    case 'ConnectionClosed':
      return new Error(
        `connection to the hauler daemon closed mid-request (socket ${error.socketPath})`,
      );
    case 'DaemonRejected':
      return new Error(`hauler daemon rejected the request (${error.code}): ${error.message}`);
    case 'DaemonNotReplaced':
      return new Error(error.message);
    case 'DaemonReplacementFailed':
      return new Error(
        `hauler replacement daemon failed its version handshake (${error.cause._tag}) at ${error.socketPath}`,
      );
    case 'SpawnDaemonError':
      return new Error(
        `hauler daemon could not be started: ${error.cause instanceof Error ? error.cause.message : String(error.cause)}`,
      );
    default: {
      const exhaustive: never = error;
      return exhaustive;
    }
  }
};

/**
 * Boundary runner: MCP/CLI cancellation aborts the socket wait, and typed
 * infrastructure failures surface as clear tool errors instead of being
 * disguised as "not found" / "timed out".
 */
export const runTicketEffect = async <A>(
  effect: Effect.Effect<A, TicketSocketError>,
  signal: AbortSignal,
): Promise<A> => {
  const exit = await Effect.runPromiseExit(effect, { signal });
  if (Exit.isSuccess(exit)) {
    return exit.value;
  }
  const failure = Cause.findErrorOption(exit.cause);
  if (Option.isSome(failure)) {
    throw infraFailure(failure.value);
  }
  throw Cause.squash(exit.cause);
};
