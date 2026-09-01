export type ProgressEvent =
  | {
      readonly kind: 'queued';
      readonly laneKey: string;
      readonly position: number;
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
