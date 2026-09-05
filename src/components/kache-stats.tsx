import { Agent } from '@agent-bundle/runtime';
import React from 'react';

import type { KacheStatusReport } from '../daemon/protocol.js';

import { DataList, Heading, Table } from './primitives.js';
import { UnavailableState } from './states.js';
import { kacheModel } from './view-models.js';
import type { KachePressureModel } from './view-models.js';

export interface KacheStatsProps {
  readonly kache: KacheStatusReport | null | undefined;
  readonly slowestLimit?: number;
  /** Clock for "ran 2h ago"; defaults to now. */
  readonly nowMs?: number;
}

/**
 * Store size against kache's limit, the last GC, `key_ms`, and the warnings
 * an operator should act on (over the limit, evictions skipped). A daemon
 * that predates the report says so instead of showing an empty panel.
 */
const KachePressure = ({ pressure }: { readonly pressure: KachePressureModel }) => {
  switch (pressure.kind) {
    case 'unavailable':
      return <UnavailableState what="kache store pressure">daemon predates the store-pressure report; upgrade it to see size, GC and key_ms.</UnavailableState>;
    case 'available':
      return (
        <>
          <DataList
            fields={[
              { label: 'store', value: pressure.store.text },
              { label: 'last GC', value: pressure.gc },
              { label: 'keying', value: pressure.keyTiming },
            ]}
          />
          {pressure.warnings.map((warning) => (
            <Agent.Context key={warning.kind}>{`kache warning: ${warning.text}`}</Agent.Context>
          ))}
        </>
      );
    default: {
      const exhaustive: never = pressure;
      return exhaustive;
    }
  }
};

/**
 * Optional kache index: freshness, coverage, store pressure, and the slowest
 * crates by profile. A daemon that reported no kache field renders nothing; a
 * daemon that looked and found no index says so honestly.
 */
export const KacheStats = ({ kache, nowMs, slowestLimit }: KacheStatsProps) => {
  const model = kacheModel(kache, slowestLimit, nowMs);
  switch (model.kind) {
    case 'unknown':
      return null;
    case 'unavailable':
      return <UnavailableState what="kache">not detected; cost priors fall back to ledger history.</UnavailableState>;
    case 'available':
      return (
        <>
          <DataList fields={[{ label: 'kache', value: model.freshness === null ? model.summary : `${model.summary}, ${model.freshness}` }]} />
          <KachePressure pressure={model.pressure} />
          {model.slowest.length === 0 ? null : (
            <>
              <Heading>Slowest crates (kache)</Heading>
              <Table columns={['Crate', 'Profile', 'Time']} rows={model.slowest.map((row) => [row.crate, row.profile, row.ms])} />
            </>
          )}
        </>
      );
    default: {
      const exhaustive: never = model;
      return exhaustive;
    }
  }
};
