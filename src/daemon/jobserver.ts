import { spawnSync } from 'node:child_process';
import { closeSync, constants, mkdirSync, openSync, readSync, statSync, writeSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';

import { isRecord } from '../lib/guards.js';

/**
 * Machine-wide GNU make jobserver FIFO shared by every cargo the daemon
 * spawns.
 *
 * Cargo and rustc both speak the make jobserver protocol
 * (`--jobserver-auth=fifo:PATH` in `MAKEFLAGS`). A single FIFO preloaded
 * with N tokens is a cross-process semaphore: however many concurrent
 * cargos the broker lanes admit, their rustc/codegen jobs collectively hold
 * at most N tokens. This bounds *global* compile parallelism, where
 * per-lane admission alone lets K cargos each spawn a machine-width of
 * rustc jobs.
 *
 * Pool lifetime is tied to the daemon: a FIFO's buffered tokens die with
 * its last open descriptor, so the daemon arms the pool once at singleton
 * acquisition and retains the descriptor until shutdown. Arming drains any
 * stale bytes first (a previous daemon's tokens do not stack), then seeds
 * exactly N. Unarmed processes — client passthroughs with no daemon —
 * inject nothing: a lone cargo sizing its own default pool is the correct
 * uncoordinated behavior, whereas pointing it at an unowned FIFO would
 * starve it down to its single implicit token.
 *
 * Semantics inherited from make: every participating cargo also holds one
 * implicit token, so worst-case parallelism is `tokens + running cargos`;
 * tokens default to `cores - 1` to compensate. A cargo killed with SIGKILL
 * leaks its held tokens (the protocol has no revocation); orderly exits —
 * including failures — return them, and every daemon restart re-arms the
 * pool to exactly N.
 */
export const jobserverFifoFileName = 'jobserver.fifo';

interface ArmedJobserver {
  readonly fd: number;
  readonly makeflags: string;
  readonly path: string;
  readonly tokens: number;
}

let armed: ArmedJobserver | null = null;

const drain = (fd: number): void => {
  const buffer = Buffer.alloc(256);
  for (;;) {
    let read: number;
    try {
      read = readSync(fd, buffer, 0, buffer.length, null);
    } catch (error) {
      if (isRecord(error) && error.code === 'EAGAIN') {
        return;
      }
      throw error;
    }
    if (read <= 0) {
      return;
    }
  }
};

export interface ArmJobserverOptions {
  /** Hauler state dir that owns the FIFO. */
  readonly stateDir: string;
  /** Token count; defaults to `max(1, cores - 1)`. */
  readonly tokens?: number;
}

/**
 * Creates (if needed), drains, and seeds the shared FIFO, retaining an open
 * descriptor so the pool survives for the daemon's lifetime. Returns false —
 * leaving the process unarmed, with spawns behaving exactly as today — when
 * the FIFO cannot be provided (no mkfifo, unwritable state dir).
 */
export const armSharedJobserver = (options: ArmJobserverOptions): boolean => {
  if (armed !== null) {
    return true;
  }
  const tokens = options.tokens ?? Math.max(1, availableParallelism() - 1);
  const path = join(options.stateDir, jobserverFifoFileName);
  try {
    mkdirSync(options.stateDir, { recursive: true });
    if (statSync(path, { throwIfNoEntry: false }) === undefined) {
      spawnSync('mkfifo', ['-m', '0666', path], { stdio: 'ignore' });
    }
    const stat = statSync(path, { throwIfNoEntry: false });
    if (stat === undefined || !stat.isFIFO()) {
      return false;
    }
    // O_RDWR so open, drain, and seed never block on a peer; O_NONBLOCK so
    // draining stale bytes ends with EAGAIN instead of waiting for writers.
    const fd = openSync(path, constants.O_RDWR | constants.O_NONBLOCK);
    try {
      drain(fd);
      writeSync(fd, Buffer.alloc(tokens, '+'));
    } catch (error) {
      closeSync(fd);
      throw error;
    }
    armed = { fd, makeflags: `-j --jobserver-auth=fifo:${path}`, path, tokens };
    return true;
  } catch {
    return false;
  }
};

/**
 * Whether this process holds the armed pool. An armed daemon lets the FIFO
 * own parallelism and must not pin `CARGO_BUILD_JOBS` on the cargos it
 * spawns, since cargo ignores an inherited jobserver once `-j` is set.
 */
export const isSharedJobserverArmed = (): boolean => armed !== null;

/** Closes the retained descriptor; the pool's tokens die with it. */
export const releaseSharedJobserver = (): void => {
  if (armed === null) {
    return;
  }
  try {
    closeSync(armed.fd);
  } catch {
    // The descriptor is being discarded either way.
  }
  armed = null;
};

/**
 * Environment delta enrolling a spawned cargo in the armed pool, or `null`
 * when this process holds no pool or the invocation pins its own
 * parallelism (`CARGO_BUILD_JOBS`, `CARGO_MAKEFLAGS`, or an inherited
 * `MAKEFLAGS` jobserver — cargo ignores an inherited jobserver when
 * `-j`/`build.jobs` is set, so injecting one would only mislead).
 */
export const sharedJobserverDelta = (
  env: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string>> | null => {
  if (armed === null) {
    return null;
  }
  if (
    env.CARGO_BUILD_JOBS !== undefined ||
    env.CARGO_MAKEFLAGS !== undefined ||
    env.MAKEFLAGS?.includes('--jobserver-auth') === true
  ) {
    return null;
  }
  const makeflags =
    env.MAKEFLAGS === undefined ? armed.makeflags : `${env.MAKEFLAGS} ${armed.makeflags}`;
  return { MAKEFLAGS: makeflags };
};
