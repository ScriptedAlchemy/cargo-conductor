import type {
  AdmissionHold,
  AttachMode,
  PrerequisiteContext,
  QueueContext,
} from '../daemon/protocol.js';

export type ProgressEvent =
  | {
      readonly kind: 'queued';
      readonly laneKey: string;
      readonly position: number;
      readonly ticket: string;
      /** The tickets `position` counts, in the order the lane expects to run them. */
      readonly ahead?: readonly string[];
      /** Prerequisites (`--after`) the job waits for before it is schedulable. */
      readonly waitingFor?: readonly string[];
      /** The job's own measured runtime estimate; omitted for a cold-start default. */
      readonly etaMs?: number;
      /** Work ahead in the lane before this job can start. */
      readonly waitEtaMs?: number;
    }
  | {
      readonly kind: 'attached';
      readonly leaderTicket: string;
      readonly mode: AttachMode;
      readonly ticket: string;
    }
  | {
      readonly kind: 'requeued';
      readonly reason: string;
      readonly ticket: string;
    }
  | {
      readonly kind: 'started';
      readonly ticket: string;
      readonly waitMs: number;
    }
  | {
      readonly kind: 'heartbeat';
      readonly elapsedMs: number;
      readonly phase: 'queued' | 'running';
      readonly ticket: string;
      readonly command?: string;
      readonly delayed?: boolean;
      readonly estimateMs?: number | null;
      readonly laneName?: string;
      readonly queue?: QueueContext;
      readonly hold?: AdmissionHold;
      /** Prerequisites (`--after`) still unsettled; the job is queued but not schedulable. */
      readonly waitingFor?: readonly PrerequisiteContext[];
      /** The daemon flagged the run stalled: idle window and the ticket whose kill frees the lane. */
      readonly stalled?: { readonly idleMs: number; readonly killTicket: string };
    }
  | {
      readonly kind: 'passthrough';
      readonly reason: string;
    }
  | {
      readonly kind: 'background';
      readonly estimateMs: number | null;
      readonly ticket: string;
      /** Set when a synchronous request was converted because its estimate exceeds the host cap. */
      readonly auto?: {
        readonly capMs: number;
        readonly host: string;
        /**
         * The caller's stdout is not a terminal (`cargo test > out.log`): the
         * redirect will hold only this notice, never the command's output,
         * so the notice must say where that output can be read (#68).
         */
        readonly stdoutRedirected: boolean;
      };
    };

const prefix = '[cargo-hauler]';

/** `45s`, `2m`, `2m30s`: the shell-heartbeat duration spelling (whole seconds, no `ms`). */
export const formatDuration = (ms: number): string => {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 90) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}m${remainder === 0 ? '' : `${remainder}s`}`;
};

const maxNamedTickets = 3;

/** `cc-1, cc-2, cc-3 +2 more`: enough to recognise a reorder without flooding the shell. */
const ticketList = (tickets: readonly string[]): string => {
  const named = tickets.slice(0, maxNamedTickets).join(', ');
  const rest = tickets.length - maxNamedTickets;
  return rest > 0 ? `${named} +${rest} more` : named;
};

/** `cc-3281 (running 2m/~5m)`, `cc-3290 (queued)`: one prerequisite a dependent waits for. */
const prerequisiteText = (prerequisite: PrerequisiteContext): string => {
  const progress =
    prerequisite.elapsedMs === undefined
      ? prerequisite.status
      : `running ${formatDuration(prerequisite.elapsedMs)}${
          prerequisite.estimateMs === undefined ? '' : `/~${formatDuration(prerequisite.estimateMs)}`
        }`;
  return `${prerequisite.ticket} (${progress})`;
};

export const formatProgressLine = (event: ProgressEvent): string => {
  switch (event.kind) {
    case 'queued': {
      const seconds = (ms: number): string => `~${Math.max(1, Math.round(ms / 1000))}s`;
      // A blocked dependent has no lane position yet: what holds it is the
      // prerequisite, not the queue.
      const blocked = event.waitingFor !== undefined && event.waitingFor.length > 0;
      const placement = blocked
        ? ` waiting for ${ticketList(event.waitingFor ?? [])}`
        : event.ahead === undefined || event.ahead.length === 0
          ? ''
          : ` behind ${ticketList(event.ahead)}`;
      const parts = [
        ...(blocked ? [] : [`${event.position} ahead`]),
        ...(blocked || event.waitEtaMs === undefined || event.waitEtaMs <= 0
          ? []
          : [`wait ${seconds(event.waitEtaMs)}`]),
        ...(event.etaMs === undefined ? [] : [`run ${seconds(event.etaMs)}`]),
      ];
      const detail = parts.length === 0 ? '' : ` (${parts.join(', ')})`;
      return `${prefix} ticket ${event.ticket} queued${placement}${detail}\n`;
    }
    case 'attached': {
      switch (event.mode) {
        case 'identity':
          return `${prefix} ticket ${event.ticket} attached to ${event.leaderTicket} (identical run in flight; replaying its output)\n`;
        case 'coverage':
          return `${prefix} ticket ${event.ticket} attached to ${event.leaderTicket} (covered by a larger run in flight)\n`;
        case 'batch':
          return `${prefix} ticket ${event.ticket} attached to ${event.leaderTicket} (batched into a merged multi-package run)\n`;
        default: {
          const exhaustive: never = event.mode;
          return exhaustive;
        }
      }
    }
    case 'requeued':
      return `${prefix} ticket ${event.ticket} requeued: ${event.reason}\n`;
    case 'started':
      return `${prefix} ticket ${event.ticket} started (waited ${event.waitMs}ms)\n`;
    case 'heartbeat': {
      if (event.command !== undefined) {
        const held = event.hold === undefined ? '' : ` · waiting: ${event.hold.detail}`;
        const prerequisites =
          event.waitingFor === undefined || event.waitingFor.length === 0
            ? ''
            : ` · waiting for ${event.waitingFor.map(prerequisiteText).join(', ')}`;
        const delayed = `${held}${prerequisites}${event.delayed === true ? ' · wait exceeds estimate — lane busy' : ''}`;
        if (event.phase === 'queued' && event.queue !== undefined) {
          const head =
            event.queue.headTicket === undefined
              ? ''
              : ` (head ${event.queue.headTicket} running${
                  event.queue.headElapsedMs === undefined
                    ? ''
                    : ` ${formatDuration(event.queue.headElapsedMs)}${
                        event.queue.headEstimateMs === undefined
                          ? ''
                          : `/~${formatDuration(event.queue.headEstimateMs)}`
                      }`
                })`;
          const lane = event.laneName === undefined ? event.ticket : event.laneName;
          return `${prefix} ${event.ticket} queued — ${event.queue.position} ahead in ${lane}${head} · wait ~${formatDuration(event.queue.waitEtaMs)}${delayed} — ${event.command}\n`;
        }
        const estimate =
          event.estimateMs === undefined || event.estimateMs === null
            ? ''
            : ` (est ~${formatDuration(event.estimateMs)})`;
        const stalled =
          event.stalled === undefined
            ? ''
            : ` · looks stalled (no CPU for ${formatDuration(event.stalled.idleMs)}) — hauler kill ${event.stalled.killTicket}`;
        return `${prefix} ${event.ticket} ${event.phase} ${formatDuration(event.elapsedMs)}${estimate}${delayed}${stalled} — ${event.command}\n`;
      }
      return `${prefix} ticket ${event.ticket} still ${event.phase} (${Math.floor(event.elapsedMs / 1000)}s)\n`;
    }
    case 'passthrough':
      return `${prefix} ${event.reason}; running cargo directly\n`;
    case 'background': {
      const eta =
        event.estimateMs === null
          ? ''
          : ` (ETA ${Math.max(1, Math.round(event.estimateMs / 1000))}s)`;
      const retrieve = `Retrieve with: hauler result ${event.ticket}\nAwait with: hauler await ${event.ticket}\n`;
      if (event.auto === undefined) {
        return `${prefix} ticket ${event.ticket} submitted in background${eta}\n${retrieve}`;
      }
      const redirected = event.auto.stdoutRedirected
        ? `; your redirected stdout receives no output; read it with \`hauler result ${event.ticket} --full\``
        : '';
      return `${prefix} ticket ${event.ticket} estimate${eta} exceeds the ${event.auto.host} shell cap (${formatDuration(event.auto.capMs)}); submitted in background, not run yet (exit 75)${redirected}\n${retrieve}`;
    }
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
};
