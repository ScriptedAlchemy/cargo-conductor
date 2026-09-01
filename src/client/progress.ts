import type { AttachMode } from '../daemon/protocol.js';

export type ProgressEvent =
  | {
      readonly kind: 'queued';
      readonly laneKey: string;
      readonly position: number;
      readonly ticket: string;
      readonly etaMs?: number;
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
    }
  | {
      readonly kind: 'passthrough';
      readonly reason: string;
    }
  | {
      readonly kind: 'background';
      readonly estimateMs: number | null;
      readonly ticket: string;
    };

const prefix = '[cargo-conductor]';

const formatElapsed = (elapsedMs: number): string => `${Math.floor(elapsedMs / 1000)}s`;

export const formatProgressLine = (event: ProgressEvent): string => {
  switch (event.kind) {
    case 'queued': {
      const eta =
        event.etaMs === undefined ? '' : `, eta ~${Math.max(1, Math.round(event.etaMs / 1000))}s`;
      return `${prefix} ticket ${event.ticket} queued (${event.position} ahead${eta})\n`;
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
    case 'heartbeat':
      return `${prefix} ticket ${event.ticket} still ${event.phase} (${formatElapsed(event.elapsedMs)})\n`;
    case 'passthrough':
      return `${prefix} ${event.reason}; running cargo directly\n`;
    case 'background': {
      const eta =
        event.estimateMs === null
          ? ''
          : ` (ETA ${Math.max(1, Math.round(event.estimateMs / 1000))}s)`;
      return `${prefix} ticket ${event.ticket} submitted in background${eta}\nRetrieve with: conductor result ${event.ticket}\nAwait with: conductor await ${event.ticket}\n`;
    }
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
};
