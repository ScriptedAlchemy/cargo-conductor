import type { AgentLineage, AgentRequestContext } from '@agent-bundle/runtime';

import type {
  KacheStatusReport,
  LaneStatus,
  PrerequisiteContext,
  RequestRecord,
  SystemLoadReport,
} from '../daemon/protocol.js';
import type { DaemonHealth } from '../lib/daemon-health.js';
import { formatBytes, formatMs, heavyCapNote, pathBasename, relativeTime, shortenPath } from '../lib/format.js';
import type { StatusResult } from '../lib/protocol-schemas.js';
import { countWord } from '../lib/text.js';
import { cliVersion, versionSkewLine } from '../lib/version-skew.js';

import { commandText, diagnosticCounts } from './headlines.js';

/*
 * View-models: pure projections from daemon records and request context onto
 * the fields a component prints. Components render these and nothing else,
 * so the same model feeds the MCP document, the CLI Markdown, and a test
 * assertion without re-deriving strings in three places.
 */

// ---------------------------------------------------------------------------
// Daemon badge (layout shell header)

export interface DaemonBadgeModel {
  readonly state: DaemonHealth['state'];
  readonly headline: string;
  readonly detail: string | null;
  /** The resolved state directory, so a reader sees which ledger and socket this is (#75). */
  readonly stateDir: string | null;
  /** `daemon 0.4.2 ≠ cli 0.4.4 — restart it with …` when the running daemon is another build (#75). */
  readonly skew: string | null;
}

export interface DaemonBadgeShell {
  /** The version of the CLI/MCP build rendering the badge; defaults to this build's. */
  readonly cliVersion?: string;
  readonly stateDir?: string;
}

const unresponsiveDetail = (
  reason: 'accept-timeout' | 'answer-timeout' | 'connection-closed',
  timeoutMs: number,
): string => {
  switch (reason) {
    case 'accept-timeout':
      return `did not accept a connection within ${formatMs(timeoutMs)} (machine saturated); ledger reads still work`;
    case 'answer-timeout':
      return `accepted the connection but sent no status within ${formatMs(timeoutMs)} (busy fanning out output); ledger reads still work`;
    case 'connection-closed':
      return 'closed the connection before answering; ledger reads still work';
    default: {
      const exhaustive: never = reason;
      return exhaustive;
    }
  }
};

export const daemonBadgeModel = (
  health: DaemonHealth,
  nowMs: number,
  shell: DaemonBadgeShell = {},
): DaemonBadgeModel => {
  const stateDir = shell.stateDir ?? null;
  switch (health.state) {
    case 'running': {
      const lanes = health.busyLanes === 0
        ? 'no lanes busy'
        : `${countWord(health.busyLanes, 'lane')} busy`;
      const riding = health.riding === 0 ? '' : ` +${health.riding} riding`;
      return {
        detail: `${health.running}/${health.maxConcurrent} permits${riding}, ${health.queued} queued · ${lanes} · up since ${relativeTime(health.startedAtMs, nowMs)}`,
        headline: `daemon running (pid ${health.pid})`,
        skew: versionSkewLine(health.version, shell.cliVersion ?? cliVersion),
        state: health.state,
        stateDir,
      };
    }
    case 'stopped':
      return {
        detail: health.reason === 'socket-missing'
          ? 'no socket; it starts on demand with the next cargo request'
          : 'socket present but connection refused; a stale socket from an earlier daemon',
        headline: 'daemon stopped',
        skew: null,
        state: health.state,
        stateDir,
      };
    case 'unresponsive':
      return {
        detail: unresponsiveDetail(health.reason, health.timeoutMs),
        headline: 'daemon unresponsive',
        skew: null,
        state: health.state,
        stateDir,
      };
    case 'unreachable':
      return {
        detail: `socket present but could not be opened (${health.detail}); the daemon may be running — check permissions on the state directory`,
        headline: 'daemon unreachable',
        skew: null,
        state: health.state,
        stateDir,
      };
    case 'unprobed':
      return { detail: null, headline: 'daemon not probed on this surface', skew: null, state: health.state, stateDir };
    default: {
      const exhaustive: never = health;
      return exhaustive;
    }
  }
};

// ---------------------------------------------------------------------------
// Lane board

export interface LaneRowModel {
  /** Leaders past their build still running tests here while the lane is free for the next compile; null when none. */
  readonly executing: string | null;
  readonly name: string;
  readonly running: string;
  readonly queued: number;
  readonly runningCommand: string | null;
  readonly runningFor: string | null;
  /** `stalled 12m` when the daemon flagged the lane head (#46). */
  readonly stalled: string | null;
}

export interface LaneBoardModel {
  readonly rows: readonly LaneRowModel[];
  readonly idleLanes: number;
}

export const laneName = (lane: Pick<LaneStatus, 'workspaceRoot' | 'targetDir'>): string =>
  `${pathBasename(lane.workspaceRoot)} (${pathBasename(lane.targetDir)})`;

export const laneBoardModel = (
  lanes: readonly LaneStatus[],
  active: readonly RequestRecord[],
  nowMs: number,
): LaneBoardModel => {
  const byTicket = new Map(active.map((record) => [record.ticket, record]));
  const busy = lanes.filter(
    (lane) =>
      lane.queued > 0 ||
      lane.runningTicket !== null ||
      (lane.executingTickets?.length ?? 0) > 0,
  );
  return {
    idleLanes: lanes.length - busy.length,
    rows: busy.map((lane) => {
      const leader = lane.runningTicket === null ? undefined : byTicket.get(lane.runningTicket);
      const executing = lane.executingTickets ?? [];
      return {
        executing: executing.length === 0 ? null : executing.join(', '),
        name: laneName(lane),
        queued: lane.queued,
        running: lane.runningTicket ?? '—',
        runningCommand: leader === undefined ? null : commandText(leader),
        runningFor: leader?.startedAtMs === null || leader?.startedAtMs === undefined
          ? null
          : formatMs(Math.max(0, nowMs - leader.startedAtMs)),
        stalled: leader?.stall === undefined ? null : `stalled ${formatMs(leader.stall.idleMs)}`,
      };
    }),
  };
};

// ---------------------------------------------------------------------------
// Admission

export interface AdmissionModel {
  readonly permits: string | null;
  readonly load: string | null;
  readonly memory: string | null;
  readonly paused: boolean;
}

const loadLine = (system: SystemLoadReport): string => {
  const io = system.ioWaitPercent === undefined ? '' : `, iowait ${system.ioWaitPercent.toFixed(0)}%`;
  return `load ${system.loadAvg1.toFixed(1)} on ${system.cores} cores${io}`;
};

const memoryLine = (system: SystemLoadReport): string | null => {
  if (system.memClamp !== undefined && system.memClamp !== 'none') {
    return `pressure ${system.memClamp} (admission ${system.memClamp === 'hard' ? 'paused' : 'reduced'})`;
  }
  return system.memAvailableBytes === undefined ? null : `${formatBytes(system.memAvailableBytes)} available`;
};

export const admissionModel = (status: Pick<StatusResult, 'active' | 'maxConcurrent' | 'system'>): AdmissionModel => {
  const running = status.active.filter((record) => record.status === 'running');
  // Riders share a leader's cargo process and hold no permit of their own.
  const leaders = running.filter((record) => record.attachedTo === null).length;
  const riders = running.length - leaders;
  const queued = status.active.filter((record) => record.status === 'queued').length;
  const heavy = heavyCapNote(status.system?.heavy);
  return {
    load: status.system === undefined ? null : loadLine(status.system),
    memory: status.system === undefined ? null : memoryLine(status.system),
    paused: status.system?.memClamp === 'hard',
    permits: status.maxConcurrent === null
      ? null
      : `${leaders} running of ${status.maxConcurrent} permits${heavy === null ? '' : ` (${heavy})`}${riders === 0 ? '' : `, ${riders} riding shared builds`}, ${queued} queued`,
  };
};

// ---------------------------------------------------------------------------
// kache

export type KacheModel =
  | { readonly kind: 'unknown' }
  | { readonly kind: 'unavailable' }
  | {
      readonly kind: 'available';
      readonly summary: string;
      readonly freshness: string | null;
      readonly slowest: readonly { readonly crate: string; readonly profile: string; readonly ms: string }[];
    };

export const kacheModel = (kache: KacheStatusReport | null | undefined, slowestLimit = 5): KacheModel => {
  if (kache === undefined || kache === null) {
    return { kind: 'unknown' };
  }
  if (!kache.available) {
    return { kind: 'unavailable' };
  }
  return {
    freshness: kache.eventsFreshMs === null ? null : `events ${formatMs(kache.eventsFreshMs)} old`,
    kind: 'available',
    slowest: kache.topCrates.slice(0, slowestLimit).map((entry) => ({
      crate: entry.crate,
      ms: formatMs(entry.ms),
      profile: entry.profile,
    })),
    summary: `${countWord(kache.entryCount, 'entry', 'entries')} across ${countWord(kache.distinctCrates, 'crate')} (${formatBytes(kache.indexSizeBytes)})`,
  };
};

// ---------------------------------------------------------------------------
// Sharing / savings

export const savingsLine = (status: Pick<StatusResult, 'savings'>): string | null => {
  const totals = status.savings?.totals;
  if (totals === undefined || totals.ridersServed === 0) {
    return null;
  }
  return `${countWord(totals.ridersServed, 'request')} attached to in-flight runs, ~${formatMs(totals.savedComputeMs)} of compute avoided`;
};

// ---------------------------------------------------------------------------
// Lineage (who asked)

export interface LineageModel {
  readonly conversation: string;
  readonly root: string;
  readonly depth: number;
  readonly parent: string | null;
  readonly resolution: AgentLineage['resolution'];
  readonly subagent: string | null;
}

export const lineageModel = (lineage: AgentRequestContext['lineage']): LineageModel | null => {
  if (lineage.state !== 'available') {
    return null;
  }
  const value = lineage.value;
  return {
    conversation: value.conversation,
    depth: value.depth,
    parent: value.parent ?? null,
    resolution: value.resolution,
    root: value.root,
    subagent: value.subagent === undefined
      ? null
      : `${value.subagent.type ?? 'subagent'} ${value.subagent.id}`,
  };
};

export const lineageLine = (model: LineageModel): string => {
  const position = model.depth === 0
    ? 'root conversation'
    : `depth ${model.depth} under ${model.root}${model.parent === null ? '' : ` via ${model.parent}`}`;
  const subagent = model.subagent === null ? '' : ` · ${model.subagent}`;
  return `conversation ${model.conversation} (${position}${subagent}; ${model.resolution})`;
};

// ---------------------------------------------------------------------------
// Ticket card

export interface TicketCardModel {
  /** Prerequisites the request was submitted `--after`, e.g. `cc-3, cc-4`. */
  readonly after: string | null;
  readonly attached: string | null;
  readonly command: string;
  readonly diagnosticsSummary: string | null;
  readonly error: string | null;
  readonly exit: string | null;
  readonly finished: string | null;
  readonly lane: string;
  readonly queue: string | null;
  readonly quiet: string | null;
  readonly ranAs: string | null;
  /** Stall verdict with the kill that frees the lane; null while the run shows progress. */
  readonly stalled: string | null;
  readonly started: string | null;
  readonly waited: string | null;
  readonly where: string;
}

const attachText = (record: RequestRecord): string | null => {
  if (record.attachedTo === null) {
    return null;
  }
  const mode = record.attachMode === null ? '' : ` (${record.attachMode})`;
  const saved = record.savedComputeMs === null || record.savedComputeMs === undefined
    ? ''
    : `, saved ~${formatMs(record.savedComputeMs)} of compute`;
  return `rode ${record.attachedTo}${mode}${saved}`;
};

/** `cc-3 (running 2m/~5m)` or `cc-4 (queued)`: one unsettled prerequisite. */
const prerequisiteText = (prerequisite: PrerequisiteContext): string => {
  const progress = prerequisite.elapsedMs === undefined
    ? prerequisite.status
    : `running ${formatMs(prerequisite.elapsedMs)}${prerequisite.estimateMs === undefined ? '' : `/~${formatMs(prerequisite.estimateMs)}`}`;
  return `${prerequisite.ticket} (${progress})`;
};

/** What a queued ticket is waiting on: prerequisites first (it has no lane position while blocked), then the lane. */
export const waitsForText = (record: RequestRecord): string | null =>
  record.waitingFor === undefined || record.waitingFor.length === 0
    ? null
    : `waits for ${record.waitingFor.map(prerequisiteText).join(', ')}`;

const queueText = (record: RequestRecord): string | null => {
  const queue = record.queue;
  if (record.status !== 'queued') {
    return null;
  }
  const head = queue?.headTicket === undefined
    ? ''
    : ` behind ${queue.headTicket}${queue.headElapsedMs === undefined ? '' : ` (running ${formatMs(queue.headElapsedMs)})`}`;
  const parts = [
    waitsForText(record),
    queue === undefined ? null : `${queue.position} ahead${head}, wait ~${formatMs(queue.waitEtaMs)}`,
    record.admissionHold === undefined ? null : `waiting: ${record.admissionHold.detail}`,
    record.delayed === true ? 'wait exceeds estimate — lane busy' : null,
    queue?.headEstimateState === 'overrun' ? 'head overrunning its estimate but alive' : null,
  ].filter((part) => part !== null);
  return parts.length === 0 ? null : parts.join('; ');
};

/**
 * A stalled leader overran its estimate with no process-tree CPU and no
 * output (#46). Riders share the process, so the kill names the leader; an
 * orphaned leader is one whose submitting connection is gone.
 */
const stalledText = (record: RequestRecord): string | null => {
  if (record.status !== 'running' || record.stall === undefined) {
    return null;
  }
  const owner = record.orphaned === true ? '; owner disconnected' : '';
  return `looks stalled: no CPU for ${formatMs(record.stall.idleMs)} and no output${owner} — hauler kill ${record.attachedTo ?? record.ticket}`;
};

const ranAs = (record: RequestRecord): string | null => {
  if (record.execArgv === null) {
    return null;
  }
  const cleaned = record.execArgv.filter((part) => !part.startsWith('--message-format='));
  const same = cleaned.length === record.argv.length && cleaned.every((part, index) => part === record.argv[index]);
  return same ? null : cleaned.join(' ');
};

export const ticketCardModel = (record: RequestRecord, nowMs: number): TicketCardModel => {
  const who = [record.host, record.session].filter((part) => part !== null).join(' / ');
  return {
    after: record.after.length === 0 ? null : record.after.join(', '),
    attached: attachText(record),
    command: commandText(record),
    diagnosticsSummary: diagnosticCounts(record),
    error: record.error,
    exit: record.exitCode === null
      ? record.signal
      : `${record.exitCode}${record.signal === null ? '' : ` (${record.signal})`}`,
    finished: record.finishedAtMs === null ? null : relativeTime(record.finishedAtMs, nowMs),
    lane: record.laneKey,
    queue: queueText(record),
    quiet: record.status === 'running' && record.quietMs !== undefined && record.quietMs >= 60_000
      ? `no output for ${formatMs(record.quietMs)}`
      : null,
    ranAs: ranAs(record),
    stalled: stalledText(record),
    started: record.startedAtMs === null ? null : relativeTime(record.startedAtMs, nowMs),
    waited: record.waitMs === null ? null : formatMs(record.waitMs),
    where: `${shortenPath(record.cwd)}${who === '' ? '' : ` · ${who}`}`,
  };
};

// ---------------------------------------------------------------------------
// Build diagnostics (cargo output → structured rows)

export interface DiagnosticRowModel {
  readonly level: 'error' | 'warning';
  readonly code: string | null;
  readonly message: string;
  readonly location: string | null;
}

export interface BuildDiagnosticsModel {
  /** One index row per recognised `error[E…]`/`warning:` block (summary lines excluded). */
  readonly rows: readonly DiagnosticRowModel[];
  readonly errorCount: number | null;
  readonly warningCount: number | null;
  /**
   * Every captured diagnostic block, verbatim and in order — spans, expected/
   * found types, notes, and suggested fixes included. The rows above are an
   * index into this text, never a replacement for it.
   */
  readonly verbatim: string;
}

const headerPattern = /^(error|warning)(?:\[(E\d{4})\])?:\s*(.+?)\s*$/u;
const locationPattern = /^\s*-->\s*(\S+)/u;

const parseDiagnosticBlock = (block: string): DiagnosticRowModel | null => {
  const lines = block.replace(/\n$/u, '').split('\n');
  const header = lines[0] === undefined ? null : headerPattern.exec(lines[0]);
  if (header === null) {
    return null;
  }
  const [, level, code, message] = header;
  if ((level !== 'error' && level !== 'warning') || message === undefined) {
    return null;
  }
  const location = lines.slice(1).map((line) => locationPattern.exec(line)?.[1]).find((match) => match !== undefined);
  return { code: code ?? null, level, location: location ?? null, message };
};

/** Cargo's summary lines (`error: could not compile …`, `warning: N warnings emitted`) are counts, not findings. */
const isSummaryDiagnostic = (row: DiagnosticRowModel): boolean =>
  row.code === null && (
    /^could not compile/u.test(row.message) ||
    /^aborting due to/u.test(row.message) ||
    /warnings? emitted$/u.test(row.message) ||
    /^`[^`]+` \(.*\) generated \d+ warnings?/u.test(row.message)
  );

export const buildDiagnosticsModel = (
  record: Pick<RequestRecord, 'diagnostics' | 'errorCount' | 'warningCount'>,
): BuildDiagnosticsModel => {
  const blocks = record.diagnostics ?? [];
  const rows = blocks.flatMap((block) => {
    const row = parseDiagnosticBlock(block);
    return row === null || isSummaryDiagnostic(row) ? [] : [row];
  });
  return { errorCount: record.errorCount, rows, verbatim: blocks.join(''), warningCount: record.warningCount };
};
