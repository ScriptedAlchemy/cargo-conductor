import React from 'react';

import type { KacheStatusReport } from '../daemon/protocol.js';

import { DataList, Heading, Table } from './primitives.js';
import { UnavailableState } from './states.js';
import { kacheModel } from './view-models.js';

export interface KacheStatsProps {
  readonly kache: KacheStatusReport | null | undefined;
  readonly slowestLimit?: number;
}

/**
 * Optional kache index: freshness, coverage, and the slowest crates by
 * profile. A daemon that reported no kache field renders nothing; a daemon
 * that looked and found no index says so honestly.
 */
export const KacheStats = ({ kache, slowestLimit }: KacheStatsProps) => {
  const model = kacheModel(kache, slowestLimit);
  switch (model.kind) {
    case 'unknown':
      return null;
    case 'unavailable':
      return <UnavailableState what="kache">not detected; cost priors fall back to ledger history.</UnavailableState>;
    case 'available':
      return (
        <>
          <DataList fields={[{ label: 'kache', value: model.freshness === null ? model.summary : `${model.summary}, ${model.freshness}` }]} />
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
