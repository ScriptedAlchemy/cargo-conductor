import { version } from 'agent-bundle/meta';
import React from 'react';

import { cliSurface, mcpSurface } from '../../components/surface.js';
import { APP_RESOURCE_URI } from '../../constants.js';

/**
 * Rendered skill: the build turns this component into `skills/hauler-dashboard/SKILL.md`
 * for every host. It is computed from the same sources the plugin ships — the
 * release version, the MCP App resource URI, and the tool and CLI spellings —
 * so the document cannot drift from the surface it describes.
 */
export const frontmatter = {
  description:
    'Use when opening, previewing, interpreting, or troubleshooting the cargo-hauler dashboard, its metrics windows, admission state, lanes, kache data, or live ticket output.',
  name: 'hauler-dashboard',
};

const filters = ['--session', '--cwd', '--ticket', '--status', '--command-contains'] as const;

export default () => (
  <>
    <h1>hauler-dashboard</h1>
    <p>
      Use the dashboard for machine-wide fleet state (cargo-hauler {version}). Use the <code>cargo-hauler</code>{' '}
      Skill for submitting, scoping, or waiting on work.
    </p>
    <h2>Open it</h2>
    <ul>
      <li>
        <strong>MCP App host:</strong> call <code>{mcpSurface.status}</code>. Hosts that render MCP Apps attach{' '}
        <code>{APP_RESOURCE_URI}</code> beside the result; the same document's text form carries the daemon
        badge, admission meter, lane board, in-flight and recent tickets, and kache summary.
      </li>
      <li>
        <strong>Plain browser:</strong> run <code>hauler dashboard</code>. It serves the App standalone against
        the plugin's own <code>hauler</code> server, opens it, and stays in the foreground until Ctrl-C; the panels
        show the daemon's own data and poll every five seconds. From the plugin checkout, <code>pnpm run dev</code>{' '}
        and the Workbench's MCP page preview <code>{APP_RESOURCE_URI}</code> the same way.
      </li>
    </ul>
    <h2>Read the panels</h2>
    <ul>
      <li>
        <strong>Contention:</strong> machine load, CPU I/O wait, disk pressure, and admission permits.{' '}
        <code>3/5 +1 riding</code> means three real Cargo processes hold permits and one request is sharing
        existing work.
      </li>
      <li>
        <strong>In flight / Queue:</strong> active leaders and waiting tickets, including workspace, submitter,
        elapsed/wait time, and cost estimate.
      </li>
      <li>
        <strong>Metrics:</strong> switch among <code>1h</code>, <code>24h</code>, and <code>all</code>. Run
        counts, outcomes, and percentiles use the selected window. Compute avoided, latency saved, and riders
        served are all-time SQLite-ledger totals; negative latency is included.
      </li>
      <li>
        <strong>Kache:</strong> optional machine-wide cache freshness, active compile roots, and slowest crates
        grouped by profile. No panel means kache is unavailable or disabled, not that the daemon failed.
      </li>
      <li>
        <strong>Lanes:</strong> work grouped by resolved <code>(workspace root, target dir)</code>. Only lanes
        with queued or running work are active.
      </li>
      <li>
        <strong>History:</strong> finished tickets and the command each request actually ran as, including
        composite batch expansion.
      </li>
    </ul>
    <p>
      Click an in-flight row to open its live output drawer. It refreshes every three seconds. Completed and
      queued rows show their durable ledger state.
    </p>
    <h2>Diagnose contention</h2>
    <ol>
      <li>Check the admission meter before assuming the daemon is stalled.</li>
      <li>Match queued work to its lane and current leader.</li>
      <li>
        Filter with <code>{cliSurface.status}</code>{' '}
        {filters.map((flag, index) => (
          <React.Fragment key={flag}>
            {index === 0 ? '' : ', '}
            <code>{flag}</code>
          </React.Fragment>
        ))}{' '}
        (or the equivalent structured fields of <code>{mcpSurface.status}</code>); do not replace the dashboard
        with <code>ps</code> polling.
      </li>
      <li>
        Await or attach to the ticket with <code>{mcpSurface.await}</code> / <code>{cliSurface.await}</code>. Do
        not kill Cargo to clear a lane.
      </li>
    </ol>
  </>
);
