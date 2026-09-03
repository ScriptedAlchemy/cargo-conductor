import * as Cause from 'effect/Cause';
import type * as Deferred from 'effect/Deferred';
import * as Effect from 'effect/Effect';
import type * as Ref from 'effect/Ref';

import { cargoJsonDemuxFlag } from '../lib/argv.js';

import { hasLibKind } from './cargo-json.js';
import type { TailBuffer } from './executor.js';
import type { NormalizedCargoIntent } from './intent-normalizer.js';
import type { AdmissionHold, AttachMode, EstimateSource, FinishedStatus } from './protocol.js';
import type { ReplayAudience, ReplayBuffer, ReplayChunk } from './replay.js';

/**
 * Mutable job and attachment fields change only inside synchronous frames, so
 * gate checks, registration, and settlement cannot interleave.
 */

export interface SubmitInput {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly workspaceRoot?: string | undefined;
  readonly env?: Readonly<Record<string, string>> | undefined;
  readonly session?: string | undefined;
  readonly host?: string | undefined;
  readonly background?: boolean | undefined;
  readonly holdStop?: boolean | undefined;
  /** The caller's stdout and stderr are one file; merge the child's channels to keep its write order. */
  readonly mergeStderr?: boolean | undefined;
}

export interface StartedInfo {
  readonly ticket: string;
  readonly waitMs: number;
}

export interface OutputInfo {
  readonly ticket: string;
  readonly channel: 'stdout' | 'stderr';
  readonly data: string;
}

export interface ExitInfo {
  readonly ticket: string;
  readonly status: FinishedStatus;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly waitMs: number;
  readonly runMs: number;
  readonly error: string | null;
}

export interface RequeuedInfo {
  readonly ticket: string;
  readonly reason: string;
}

/**
 * Callbacks are invoked from lane worker fibers, potentially after the
 * originating connection is gone; the broker guards every invocation so a
 * failing callback can never take a lane down.
 */
export interface SubmitCallbacks {
  /**
   * Registers connection ownership in the same uninterruptible commit that
   * creates the ticket. False means the connection already closed.
   */
  readonly onRegistered?: (ticket: string) => Effect.Effect<boolean>;
  readonly onStarted: (info: StartedInfo) => Effect.Effect<void>;
  readonly onOutput: (info: OutputInfo) => Effect.Effect<void>;
  readonly onExit: (info: ExitInfo) => Effect.Effect<void>;
  readonly onRequeued?: (info: RequeuedInfo) => Effect.Effect<void>;
}

export type JobState = 'queued' | 'starting' | 'kill-requested' | 'running' | 'finished';

export interface Attachment {
  readonly id: number;
  readonly ticket: string;
  /** Assigned by tryRegisterAttachment in the same frame that registers it. */
  mode: AttachMode;
  readonly input: SubmitInput;
  readonly intent: NormalizedCargoIntent;
  readonly callbacks: SubmitCallbacks;
  readonly createdAtMs: number;
  readonly estimateMs: number;
  readonly estimateSource: EstimateSource;
  readonly tail: TailBuffer;
  attachedAtMs: number;
  /** True once the replay backlog is flushed; live output then flows directly. */
  live: boolean;
  startNotified: boolean;
  startedAtMs: number | null;
  readonly pendingLive: ReplayChunk[];
  diagnostics: DiagnosticAccumulator | null;
}

/** A fresh, not-yet-live attachment; `mode` may be reassigned at registration. */
export const makeAttachment = (
  fields: Pick<
    Attachment,
    | 'id'
    | 'ticket'
    | 'mode'
    | 'input'
    | 'intent'
    | 'callbacks'
    | 'createdAtMs'
    | 'estimateMs'
    | 'estimateSource'
    | 'tail'
    | 'attachedAtMs'
  >,
): Attachment => ({
  ...fields,
  live: false,
  startNotified: false,
  startedAtMs: null,
  pendingLive: [],
  diagnostics: null,
});

interface DiagnosticEntry {
  readonly order: number;
  readonly rendered: string;
}

export interface DiagnosticAccumulator {
  errorCount: number;
  warningCount: number;
  readonly diagnostics: DiagnosticEntry[];
}

/** Per-unit completion state accumulated from the cargo JSON message stream. */
export interface DemuxState {
  /** Package name -> target kinds with a completed compiler-artifact. */
  readonly unitKinds: Map<string, Set<string>>;
  /** Packages whose lib-shaped unit produced an error-level diagnostic. */
  readonly libErrors: Set<string>;
  readonly globalDiagnostics: DiagnosticAccumulator;
  readonly unscopedDiagnostics: DiagnosticAccumulator;
  readonly packageDiagnostics: Map<string, DiagnosticAccumulator>;
  nextDiagnosticOrder: number;
}

export interface Job {
  readonly id: number;
  readonly ticket: string;
  readonly laneKey: string;
  readonly input: SubmitInput;
  readonly intent: NormalizedCargoIntent;
  readonly callbacks: SubmitCallbacks;
  readonly killSignal: Deferred.Deferred<void>;
  readonly state: Ref.Ref<JobState>;
  readonly queuedAtMs: number;
  readonly replay: ReplayBuffer;
  readonly attachments: Map<string, Attachment>;
  /** Closed (in the same sync frame as settlement) before exit fan-out begins. */
  readonly attachGate: { open: boolean };
  /** Argv actually executed (demux appends --message-format; batching may add -p). */
  execArgv: readonly string[];
  /** Non-null when the run is demultiplexed through cargo's JSON stream. */
  readonly demux: DemuxState | null;
  /** Leader-view output tail; authoritative for the ledger row. */
  readonly tail: TailBuffer;
  /** Cost-model estimate at submission; feeds lane scheduling. */
  readonly estimateMs: number;
  /** Provenance of `estimateMs`; a `default` prior must never trip a client's auto-background. */
  readonly estimateSource: EstimateSource;
  /** Real start of the cargo process, shared by attached ledger rows. */
  startedAtMs: number | null;
  /** Start time or most recent brokered output, for output-silence visibility. */
  lastOutputAtMs: number | null;
  /** Set while an admission arm holds this lane head back from its permit. */
  admissionHold: AdmissionHold | null;
  /** Fail-fast signal captured at submission (topology stat, cached). */
  readonly editedRecently: boolean;
  /** Workspace-internal transitive deps of this job's packages (topology, cached). */
  readonly depClosure: ReadonlySet<string>;
}

export type InFlightEntry =
  | { readonly kind: 'leader'; readonly job: Job }
  | { readonly kind: 'attachment'; readonly leader: Job; readonly attachment: Attachment };

const demuxSubcommands = new Set(['build', 'check', 'clippy']);
const maxDiagnostics = 5;
const maxDiagnosticLength = 2_000;

export const makeDiagnosticAccumulator = (): DiagnosticAccumulator => ({
  errorCount: 0,
  warningCount: 0,
  diagnostics: [],
});

const copyDiagnosticAccumulator = (
  accumulator: DiagnosticAccumulator,
): DiagnosticAccumulator => ({
  errorCount: accumulator.errorCount,
  warningCount: accumulator.warningCount,
  diagnostics: [...accumulator.diagnostics],
});

export const addDiagnostic = (
  accumulator: DiagnosticAccumulator,
  level: string | null,
  rendered: string | null,
  order: number,
): void => {
  if (level === 'error') {
    accumulator.errorCount += 1;
  } else if (level === 'warning') {
    accumulator.warningCount += 1;
  } else {
    return;
  }
  // Stored verbatim, ANSI included: display surfaces strip per consumer.
  if (rendered !== null && rendered.length > 0 && accumulator.diagnostics.length < maxDiagnostics) {
    accumulator.diagnostics.push({
      order,
      rendered: rendered.slice(0, maxDiagnosticLength),
    });
  }
};

const mergeDiagnosticAccumulators = (
  accumulators: readonly DiagnosticAccumulator[],
): DiagnosticAccumulator => ({
  errorCount: accumulators.reduce((sum, item) => sum + item.errorCount, 0),
  warningCount: accumulators.reduce((sum, item) => sum + item.warningCount, 0),
  diagnostics: accumulators
    .flatMap((item) => item.diagnostics)
    .sort((left, right) => left.order - right.order)
    .slice(0, maxDiagnostics),
});

export const diagnosticsForAttachment = (
  demux: DemuxState,
  attachment: Attachment,
): DiagnosticAccumulator => {
  if (attachment.mode === 'identity') {
    return copyDiagnosticAccumulator(demux.globalDiagnostics);
  }
  const accumulators = [demux.unscopedDiagnostics];
  for (const packageName of new Set(attachment.intent.packages)) {
    const scoped = demux.packageDiagnostics.get(packageName);
    if (scoped !== undefined) {
      accumulators.push(scoped);
    }
  }
  return mergeDiagnosticAccumulators(accumulators);
};

export const diagnosticFinishFields = (
  accumulator: DiagnosticAccumulator | null,
): {
  readonly errorCount?: number;
  readonly warningCount?: number;
  readonly diagnostics?: readonly string[];
} =>
  accumulator === null
    ? {}
    : {
        errorCount: accumulator.errorCount,
        warningCount: accumulator.warningCount,
        diagnostics: accumulator.diagnostics.map((entry) => entry.rendered),
      };

/**
 * Demultiplexing rewrites the invocation to `--message-format=
 * json-diagnostic-rendered-ansi` so per-unit completion can be observed.
 * Skipped when the caller already chose a message format (their stream is
 * forwarded verbatim, unparsed) or passes trailing `--` arguments whose
 * semantics we do not model.
 */
export const planDemux = (
  intent: NormalizedCargoIntent,
  argv: readonly string[],
): { readonly execArgv: readonly string[]; readonly demux: DemuxState | null } => {
  const eligible =
    demuxSubcommands.has(intent.subcommand) &&
    !argv.some((argument) => argument.startsWith('--message-format')) &&
    !argv.includes('--');
  if (!eligible) {
    return { execArgv: argv, demux: null };
  }
  return {
    execArgv: [...argv, cargoJsonDemuxFlag],
    demux: {
      unitKinds: new Map(),
      libErrors: new Set(),
      globalDiagnostics: makeDiagnosticAccumulator(),
      unscopedDiagnostics: makeDiagnosticAccumulator(),
      packageDiagnostics: new Map(),
      nextDiagnosticOrder: 0,
    },
  };
};

/**
 * A coverage attachment can be released the moment its whole demand is
 * proven: v1 proves only `--lib` demands (a lib-shaped artifact for every
 * requested package with no error diagnostics on those lib units). Broader
 * demands wait for the leader (bin inventories need cargo metadata).
 */
export const demandSatisfied = (intent: NormalizedCargoIntent, demux: DemuxState): boolean => {
  if (intent.workspace || intent.packages.length === 0) {
    return false;
  }
  if (intent.targets.length !== 1 || intent.targets[0] !== 'lib') {
    return false;
  }
  return intent.packages.every((name) => {
    const kinds = demux.unitKinds.get(name);
    return kinds !== undefined && hasLibKind(kinds) && !demux.libErrors.has(name);
  });
};

export const isTerminalStatus = (status: string): boolean =>
  status === 'done' ||
  status === 'failed' ||
  status === 'killed' ||
  status === 'denied' ||
  status === 'passthrough';

export const guarded = (effect: Effect.Effect<void>): Effect.Effect<void> =>
  effect.pipe(
    Effect.tapDefect((cause) => Effect.logDebug('broker callback defect', cause)),
    Effect.catchCauseIf(
      (cause) => !Cause.hasInterruptsOnly(cause),
      (cause) => Effect.logError(`broker callback failed: ${Cause.pretty(cause)}`),
    ),
  );

export const attachmentReceives = (attachment: Attachment, audience: ReplayAudience): boolean => {
  if (attachment.mode === 'identity') {
    return true;
  }
  switch (audience.kind) {
    case 'all':
      return true;
    case 'identity':
      return false;
    case 'package':
      return attachment.intent.packages.includes(audience.packageName);
    default: {
      const exhaustive: never = audience;
      return exhaustive;
    }
  }
};

export const remainingEstimateMs = (job: Job, atMs: number): number =>
  job.startedAtMs === null ? job.estimateMs : Math.max(0, job.estimateMs - (atMs - job.startedAtMs));

export const delayedWaitFloorMs = 10 * 60_000;
export const quietOutputThresholdMs = 5 * 60_000;

export const queuedWaitIsDelayed = (waitMs: number, estimateMs: number): boolean =>
  waitMs > Math.max(2 * estimateMs, delayedWaitFloorMs);

export const quietMsSinceOutput = (
  lastOutputAtMs: number | null,
  atMs: number,
): number | undefined => {
  if (lastOutputAtMs === null) {
    return undefined;
  }
  const quietMs = Math.max(0, atMs - lastOutputAtMs);
  return quietMs > quietOutputThresholdMs ? quietMs : undefined;
};

export const requeueReasonFor = (mode: AttachMode, status: FinishedStatus): string =>
  mode === 'identity'
    ? 'coalesced run was killed; running your request directly'
    : `${mode === 'batch' ? 'batched' : 'covering'} ${
        status === 'killed' ? 'run was killed' : 'run failed'
      }; running your request directly`;
