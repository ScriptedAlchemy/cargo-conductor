import { version as bundledVersion } from 'agent-bundle/meta';
import * as Data from 'effect/Data';
import * as Effect from 'effect/Effect';
import type { z } from 'zod';

import { pingDaemon } from '../daemon/control.js';

import { relativeTime } from './format.js';

/** The release version of the CLI, MCP server, or hook that is running right now. */
export const cliVersion: string = bundledVersion;

/** What a `pong` says about the daemon behind the socket. */
export interface DaemonIdentity {
  readonly pid: number;
  readonly startedAtMs: number;
  readonly version: string;
}

/**
 * The daemon answered, but with a reply this build cannot read (#75). The
 * usual cause is a daemon left running across an upgrade of the plugin or
 * CLI, so the failure is reported as a version difference with the restart
 * that fixes it; the schema detail stays a second line, never the raw issue
 * array.
 */
export class DaemonVersionSkewError extends Data.TaggedError('DaemonVersionSkew')<{
  readonly socketPath: string;
  readonly cliVersion: string;
  /** Null when the daemon did not answer a ping either. */
  readonly daemon: DaemonIdentity | null;
  /** `active[0].outputPath expected string, received undefined` */
  readonly firstMismatch: string;
}> {}

export const restartHint = 'restart it with `hauler daemon restart`';

type Issue = z.ZodError['issues'][number];

const describePath = (path: readonly PropertyKey[]): string =>
  path.reduce<string>((text, key) => {
    if (typeof key === 'number') {
      return `${text}[${key}]`;
    }
    return text === '' ? String(key) : `${text}.${String(key)}`;
  }, '');

/** `active[0].outputPath expected string, received undefined`: the first issue as one clause. */
export const describeFirstIssue = (issues: readonly Issue[]): string => {
  const issue = issues[0];
  if (issue === undefined) {
    return 'reply did not match the protocol';
  }
  const path = describePath(issue.path);
  const message = issue.message.replace(/^Invalid input:\s*/u, '');
  return path === '' ? message : `${path} ${message}`;
};

/** `daemon 0.4.2 ≠ cli 0.4.4 — restart it with …`, or null when the versions agree or the daemon's is unknown. */
export const versionSkewLine = (
  daemonVersion: string | undefined,
  cli: string = cliVersion,
): string | null =>
  daemonVersion === undefined || daemonVersion === cli
    ? null
    : `daemon ${daemonVersion} ≠ cli ${cli} — ${restartHint}`;

/** Two lines: the version situation and the restart, then the first schema mismatch. */
export const formatVersionSkew = (error: DaemonVersionSkewError, nowMs: number = Date.now()): string => {
  const daemon = error.daemon;
  const headline = daemon === null
    ? `daemon at ${error.socketPath} sent a reply this CLI cannot read and did not answer a ping (this CLI is ${error.cliVersion}) — probably an older daemon; ${restartHint}`
    : daemon.version === error.cliVersion
      ? `daemon is ${daemon.version} (pid ${daemon.pid}, since ${relativeTime(daemon.startedAtMs, nowMs)}), the same version as this CLI, but its reply did not match the protocol — ${restartHint} and report the mismatch if it persists`
      : `daemon is ${daemon.version} (pid ${daemon.pid}, since ${relativeTime(daemon.startedAtMs, nowMs)}), this CLI is ${error.cliVersion} — ${restartHint}`;
  return `${headline}\nfirst mismatch: ${error.firstMismatch}`;
};

const identityTimeoutMs = 1_000;

/** Who is behind the socket, or null when nothing answered a ping in time. */
export const daemonIdentity = (
  socketPath: string,
  timeoutMs: number = identityTimeoutMs,
): Effect.Effect<DaemonIdentity | null> =>
  pingDaemon(socketPath, timeoutMs).pipe(
    Effect.map(
      (pong): DaemonIdentity => ({
        pid: pong.pid,
        startedAtMs: pong.startedAtMs,
        // Trusted-peer parsing: a daemon older than the field would send none.
        version: typeof pong.version === 'string' ? pong.version : 'unknown',
      }),
    ),
    Effect.orElseSucceed(() => null),
  );

/**
 * The daemon's version for a status report: the report's own when the daemon
 * sends one (0.4.5+), otherwise one bounded ping — the only place an older
 * daemon states it.
 */
export const learnDaemonVersion = (
  report: { readonly version?: string },
  socketPath: string,
  timeoutMs: number = identityTimeoutMs,
): Effect.Effect<string | undefined> =>
  report.version === undefined
    ? daemonIdentity(socketPath, timeoutMs).pipe(Effect.map((identity) => identity?.version))
    : Effect.succeed(report.version);

/**
 * Parses one daemon reply with the client schema (lenient about fields older
 * daemons never send), failing typed as version skew when it still does not
 * fit. The daemon is asked who it is only on that failure path.
 */
export const validateDaemonReply = <Schema extends z.ZodType>(
  schema: Schema,
  value: unknown,
  socketPath: string,
): Effect.Effect<z.output<Schema>, DaemonVersionSkewError> =>
  Effect.suspend(() => {
    const parsed = schema.safeParse(value);
    if (parsed.success) {
      return Effect.succeed(parsed.data as z.output<Schema>);
    }
    return daemonIdentity(socketPath).pipe(
      Effect.flatMap((daemon) =>
        Effect.fail(
          new DaemonVersionSkewError({
            cliVersion,
            daemon,
            firstMismatch: describeFirstIssue(parsed.error.issues),
            socketPath,
          }),
        ),
      ),
    );
  });
