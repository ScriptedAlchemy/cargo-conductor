import type {
  KacheGcReport,
  KacheStoreLimitReport,
  KacheStorePressureReport,
} from '../daemon/protocol.js';

import { formatBytes, formatMs, relativeTime } from './format.js';
import { countWord } from './text.js';

/**
 * Pure projection of the daemon's kache store-pressure report (#92) onto the
 * lines the kache panel prints. Shared by the MCP/CLI component and the
 * dashboard widget, so it must stay free of Node and DOM imports.
 */

export type KachePressureWarning =
  | { readonly kind: 'over-limit'; readonly text: string }
  | { readonly kind: 'gc-declined'; readonly text: string }
  | { readonly kind: 'gc-eviction-errors'; readonly text: string };

export interface KacheStoreLine {
  /** e.g. `503.8 GB of 429.0 GB (117%)`, or why one side is unknown. */
  readonly text: string;
  /** Fill of the store against its limit; null when either side is unknown. */
  readonly percent: number | null;
  /** Where the limit came from, for a tooltip; null when unknown. */
  readonly limitSource: string | null;
}

export interface KachePressureModel {
  readonly store: KacheStoreLine;
  /** Last GC in one line, or why it is unknown. */
  readonly gc: string;
  /** `key_ms` distribution, or null when the events tail carried none. */
  readonly keyTiming: string | null;
  readonly warnings: readonly KachePressureWarning[];
}

const limitUnknownText = (limit: Extract<KacheStoreLimitReport, { kind: 'unknown' }>): string => {
  switch (limit.reason) {
    case 'config-missing':
      return 'limit unknown: no kache config found';
    case 'not-configured':
      return 'limit unknown: local_max_size not set';
    case 'unparsable':
      return 'limit unknown: local_max_size unreadable';
    case 'store-mismatch':
      return 'limit unknown: kache config names another store';
    default: {
      const exhaustive: never = limit.reason;
      return exhaustive;
    }
  }
};

const storeLine = (pressure: KacheStorePressureReport): KacheStoreLine => {
  const { limit, storeBytes } = pressure;
  const size = storeBytes === null ? 'size unknown (index has no blobs table)' : formatBytes(storeBytes);
  switch (limit.kind) {
    case 'known': {
      const percent = storeBytes === null || limit.bytes <= 0 ? null : (storeBytes / limit.bytes) * 100;
      return {
        limitSource: limit.source,
        percent,
        text: `${size} of ${formatBytes(limit.bytes)}${percent === null ? '' : ` (${Math.round(percent)}%)`}`,
      };
    }
    case 'unknown':
      return { limitSource: null, percent: null, text: `${size}, ${limitUnknownText(limit)}` };
    default: {
      const exhaustive: never = limit;
      return exhaustive;
    }
  }
};

const gcLine = (gc: KacheGcReport, nowMs: number): string => {
  switch (gc.kind) {
    case 'unavailable':
      return gc.reason === 'missing' ? 'no GC recorded (gc_stats.json missing)' : 'gc_stats.json unreadable';
    case 'ran': {
      const parts = [
        `ran ${relativeTime(gc.lastRunAtMs, nowMs)}${gc.durationMs === null ? '' : ` in ${formatMs(gc.durationMs)}`}`,
      ];
      if (gc.declined) {
        parts.push('declined to evict');
      } else {
        parts.push(
          gc.entriesEvicted === null ? 'evictions unknown' : `${countWord(gc.entriesEvicted, 'entry', 'entries')} evicted`,
        );
        if (gc.blobsRemoved !== null) {
          parts.push(`${countWord(gc.blobsRemoved, 'blob')} removed`);
        }
        if (gc.bytesFreed !== null) {
          parts.push(`${formatBytes(gc.bytesFreed)} freed`);
        }
      }
      if (gc.evictionErrors !== null && gc.evictionErrors > 0) {
        parts.push(`${countWord(gc.evictionErrors, 'eviction')} skipped`);
      }
      return parts.join(', ');
    }
    default: {
      const exhaustive: never = gc;
      return exhaustive;
    }
  }
};

const warnings = (pressure: KacheStorePressureReport, store: KacheStoreLine): readonly KachePressureWarning[] => {
  const found: KachePressureWarning[] = [];
  if (store.percent !== null && store.percent > 100) {
    found.push({
      kind: 'over-limit',
      text: `store is over its limit (${store.text}); kache GC is not keeping up`,
    });
  }
  if (pressure.gc.kind === 'ran') {
    if (pressure.gc.declined) {
      found.push({
        kind: 'gc-declined',
        text: `last GC declined to evict anything${
          pressure.gc.entriesPinned === null ? '' : ` (${countWord(pressure.gc.entriesPinned, 'entry', 'entries')} pinned)`
        }`,
      });
    }
    if (pressure.gc.evictionErrors !== null && pressure.gc.evictionErrors > 0) {
      found.push({
        kind: 'gc-eviction-errors',
        text: `last GC skipped ${countWord(pressure.gc.evictionErrors, 'eviction')}${
          pressure.gc.evictionErrorSample === null ? '' : `: ${pressure.gc.evictionErrorSample}`
        }`,
      });
    }
  }
  return found;
};

export const kachePressureModel = (
  pressure: KacheStorePressureReport,
  nowMs: number,
): KachePressureModel => {
  const store = storeLine(pressure);
  return {
    gc: gcLine(pressure.gc, nowMs),
    keyTiming:
      pressure.keyTiming === null
        ? null
        : `key_ms mean ${formatMs(pressure.keyTiming.meanMs)} · p95 ${formatMs(pressure.keyTiming.p95Ms)} (n=${pressure.keyTiming.count})`,
    store,
    warnings: warnings(pressure, store),
  };
};
