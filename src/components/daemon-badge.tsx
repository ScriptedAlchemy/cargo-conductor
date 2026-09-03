import { Agent } from '@agent-bundle/runtime';
import React from 'react';

import type { DaemonHealth } from '../lib/daemon-health.js';

import { daemonBadgeModel } from './view-models.js';

export interface DaemonBadgeProps {
  readonly health: DaemonHealth;
  readonly nowMs: number;
}

/**
 * The shell header: one line saying what the daemon probe proved at request
 * start. Rendered by the layout above every document, so a reader never has
 * to infer daemon state from the absence of rows.
 */
export const DaemonBadge = ({ health, nowMs }: DaemonBadgeProps) => {
  const model = daemonBadgeModel(health, nowMs);
  return (
    <Agent.Text>
      {model.detail === null ? `cargo-hauler · ${model.headline}` : `cargo-hauler · ${model.headline} · ${model.detail}`}
    </Agent.Text>
  );
};
