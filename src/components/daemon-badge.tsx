import { Agent } from '@agent-bundle/runtime';
import React from 'react';

import type { DaemonHealth } from '../lib/daemon-health.js';

import { daemonBadgeModel } from './view-models.js';

export interface DaemonBadgeProps {
  readonly health: DaemonHealth;
  readonly nowMs: number;
  /** The resolved state directory (ledger, socket, ticket logs) this request talks to. */
  readonly stateDir?: string;
}

/**
 * The shell header: one line saying what the daemon probe proved at request
 * start, ending with the state directory so a reader who memorised another
 * path notices the move (#75). Rendered by the layout above every document,
 * so a reader never has to infer daemon state from the absence of rows. A
 * daemon running another build than this CLI gets a second line naming both
 * versions and the restart.
 */
export const DaemonBadge = ({ health, nowMs, stateDir }: DaemonBadgeProps) => {
  const model = daemonBadgeModel(health, nowMs, stateDir === undefined ? {} : { stateDir });
  const parts = ['cargo-hauler', model.headline, model.detail, model.stateDir === null ? null : `state dir ${model.stateDir}`];
  return (
    <>
      <Agent.Text>{parts.filter((part) => part !== null).join(' · ')}</Agent.Text>
      {model.skew === null ? null : <Agent.Text>{`cargo-hauler · ${model.skew}`}</Agent.Text>}
    </>
  );
};
