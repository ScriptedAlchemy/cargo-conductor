import { Agent } from '@agent-bundle/runtime';
import React from 'react';

import type { RequestRecord, RequestStatus } from '../daemon/protocol.js';
import { formatMs } from '../lib/format.js';
import { awaitMaxWaitMs } from '../lib/protocol-schemas.js';

import type { SurfaceNames } from './surface.js';

export interface TicketGuidanceProps {
  readonly names: SurfaceNames;
  readonly record: RequestRecord;
}

type GuidanceComponent = (props: TicketGuidanceProps) => React.JSX.Element;

/*
 * One component per ticket status. The record keyed by `RequestStatus` is
 * exhaustive by construction — adding a status to the daemon protocol fails
 * this module's type-check until its guidance exists.
 */

const PendingGuidance: GuidanceComponent = ({ names, record }) => (
  <Agent.Context>
    {`${record.ticket} is still ${record.status}. Do not re-run the same cargo command; call ${names.await} with ticket ${record.ticket} (each call waits up to ${formatMs(awaitMaxWaitMs)}; call again to keep waiting) or check ${names.result} later.`}
  </Agent.Context>
);

const DoneGuidance: GuidanceComponent = ({ record }) => (
  <Agent.Context>{`${record.ticket} succeeded; its output above is the result of that cargo run.`}</Agent.Context>
);

const FailedGuidance: GuidanceComponent = ({ record }) => (
  <Agent.Context>
    {`${record.ticket} failed (exit ${record.exitCode ?? 'unknown'}). Fix the diagnostics above before re-running; the hauler dedupes identical requests, so an unchanged retry attaches to the same result.`}
  </Agent.Context>
);

const KilledGuidance: GuidanceComponent = ({ record }) => (
  <Agent.Context>{`${record.ticket} was killed before finishing; resubmit only if the work is still needed.`}</Agent.Context>
);

const DeniedGuidance: GuidanceComponent = ({ record }) => (
  <Agent.Context>{`${record.ticket} was denied by a hook: ${record.error ?? 'see error above'}.`}</Agent.Context>
);

const PassthroughGuidance: GuidanceComponent = ({ record }) => (
  <Agent.Context>{`${record.ticket} ran directly without broker coordination.`}</Agent.Context>
);

const guidanceByStatus: Readonly<Record<RequestStatus, GuidanceComponent>> = {
  denied: DeniedGuidance,
  done: DoneGuidance,
  failed: FailedGuidance,
  killed: KilledGuidance,
  passthrough: PassthroughGuidance,
  queued: PendingGuidance,
  requested: PendingGuidance,
  running: PendingGuidance,
};

/** What to do next about this ticket, chosen by its status. */
export const TicketGuidance = (props: TicketGuidanceProps) => {
  const Guidance = guidanceByStatus[props.record.status];
  return <Guidance {...props} />;
};
