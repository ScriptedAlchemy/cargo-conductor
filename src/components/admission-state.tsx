import { Agent } from '@agent-bundle/runtime';
import React from 'react';

import type { StatusResult } from '../lib/protocol-schemas.js';

import { DataList } from './primitives.js';
import { admissionModel, savingsLine } from './view-models.js';

export interface AdmissionStateProps {
  readonly status: Pick<StatusResult, 'active' | 'maxConcurrent' | 'savings' | 'system'>;
}

/**
 * The admission meter: permits in use, machine load, memory clamp, and how
 * much work attachment has saved. A hard memory clamp is called out as a
 * paused admission gate so a stalled queue is read as policy, not a hang.
 */
export const AdmissionState = ({ status }: AdmissionStateProps) => {
  const model = admissionModel(status);
  return (
    <>
      <DataList
        fields={[
          { label: 'Admission', value: model.permits },
          { label: 'System', value: model.load },
          { label: 'Memory', value: model.memory },
          { label: 'Sharing', value: savingsLine(status) },
        ]}
      />
      {model.paused ? (
        <Agent.Context>
          Admission is paused by hard memory pressure. Queued tickets resume when MemAvailable recovers; do not kill cargo to free memory.
        </Agent.Context>
      ) : null}
    </>
  );
};
