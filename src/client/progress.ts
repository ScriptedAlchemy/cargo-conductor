export type ProgressEvent =
  | {
      readonly kind: 'queued';
      readonly laneKey: string;
      readonly position: number;
      readonly ticket: string;
    }
  | {
      readonly kind: 'attached';
      readonly leaderTicket: string;
      readonly mode: 'identity' | 'coverage';
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
    }
  | {
      readonly kind: 'passthrough';
      readonly reason: string;
    };

const prefix = '[cargo-conductor]';

const formatElapsed = (elapsedMs: number): string => `${Math.floor(elapsedMs / 1000)}s`;

export const formatProgressLine = (event: ProgressEvent): string => {
  switch (event.kind) {
    case 'queued':
      return `${prefix} ticket ${event.ticket} queued (${event.position} ahead)\n`;
    case 'attached':
      return event.mode === 'identity'
        ? `${prefix} ticket ${event.ticket} attached to ${event.leaderTicket} (identical run in flight; replaying its output)\n`
        : `${prefix} ticket ${event.ticket} attached to ${event.leaderTicket} (covered by a larger run in flight)\n`;
    case 'requeued':
      return `${prefix} ticket ${event.ticket} requeued: ${event.reason}\n`;
    case 'started':
      return `${prefix} ticket ${event.ticket} started (waited ${event.waitMs}ms)\n`;
    case 'heartbeat':
      return `${prefix} ticket ${event.ticket} still ${event.phase} (${formatElapsed(event.elapsedMs)})\n`;
    case 'passthrough':
      return `${prefix} ${event.reason}; running cargo directly\n`;
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
};
