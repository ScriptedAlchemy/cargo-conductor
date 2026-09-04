import {
  closeSync,
  constants,
  mkdtempSync,
  openSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'effect-rstest';

import {
  armSharedJobserver,
  isSharedJobserverArmed,
  makeSupportsFifoJobserver,
  parseJobserverModeSetting,
  resolveJobserverMode,
  jobserverFifoFileName,
  releaseSharedJobserver,
  sharedJobserverDelta,
} from '../src/daemon/jobserver.js';

const scratch = (): string => mkdtempSync(join(tmpdir(), 'cc-jobserver-'));

/** Non-blocking count of the tokens currently buffered in the FIFO. */
const availableTokens = (path: string): number => {
  const fd = openSync(path, constants.O_RDWR | constants.O_NONBLOCK);
  try {
    const buffer = Buffer.alloc(256);
    let total = 0;
    for (;;) {
      let read: number;
      try {
        read = readSync(fd, buffer, 0, buffer.length, null);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EAGAIN') {
          return total;
        }
        throw error;
      }
      if (read <= 0) {
        return total;
      }
      total += read;
    }
  } finally {
    closeSync(fd);
  }
};

afterEach(() => {
  releaseSharedJobserver();
});

describe('fifo jobserver host support', () => {
  it('reads GNU make 4.4+ as fifo-capable and older or foreign makes as not', () => {
    expect(makeSupportsFifoJobserver('GNU Make 4.4.1\nBuilt for x86_64-pc-linux-gnu')).toBe(true);
    expect(makeSupportsFifoJobserver('GNU Make 4.4')).toBe(true);
    expect(makeSupportsFifoJobserver('GNU Make 5.0')).toBe(true);
    // Debian/Ubuntu 22.04 and macOS ship 4.3 / 3.81: `make: *** internal
    // error: invalid --jobserver-auth string 'fifo:…'` (#76).
    expect(makeSupportsFifoJobserver('GNU Make 4.3\nBuilt for x86_64-pc-linux-gnu')).toBe(false);
    expect(makeSupportsFifoJobserver('GNU Make 3.81')).toBe(false);
    expect(makeSupportsFifoJobserver('bmake 20240314')).toBe(false);
    expect(makeSupportsFifoJobserver('')).toBe(false);
  });

  it('decides the jobserver mode from the override, then from the host make', () => {
    // No make at all: nothing shells out to make, so the FIFO is safe.
    expect(resolveJobserverMode('auto', () => null)).toBe('fifo');
    expect(resolveJobserverMode('auto', () => 'GNU Make 4.4')).toBe('fifo');
    expect(resolveJobserverMode('auto', () => 'GNU Make 4.3')).toBe('off');
    expect(resolveJobserverMode('fifo', () => 'GNU Make 4.3')).toBe('fifo');
    expect(resolveJobserverMode('off', () => 'GNU Make 4.4')).toBe('off');
    expect(parseJobserverModeSetting('bogus', () => undefined)).toBe('auto');
    expect(parseJobserverModeSetting('OFF', () => undefined)).toBe('off');
  });

  it('does not arm when the host make cannot speak fifo', () => {
    const stateDir = scratch();
    expect(armSharedJobserver({ stateDir, tokens: 2, makeVersion: () => 'GNU Make 4.3' })).toBe(false);
    expect(isSharedJobserverArmed()).toBe(false);
    expect(armSharedJobserver({ makeVersion: () => 'GNU Make 4.3', mode: 'fifo', stateDir, tokens: 2 })).toBe(true);
  });
});

describe('shared jobserver', () => {
  it('arms once, seeds exactly the requested tokens, and issues MAKEFLAGS', () => {
    const stateDir = scratch();
    try {
      expect(armSharedJobserver({ mode: 'fifo', stateDir, tokens: 3 })).toBe(true);
      const path = join(stateDir, jobserverFifoFileName);
      expect(statSync(path).isFIFO()).toBe(true);

      const delta = sharedJobserverDelta({});
      expect(delta?.MAKEFLAGS).toBe(`-j --jobserver-auth=fifo:${path}`);
      // Arming holds the pool's descriptor, so the seeded tokens persist.
      expect(availableTokens(path)).toBe(3);
    } finally {
      releaseSharedJobserver();
      rmSync(stateDir, { force: true, recursive: true });
    }
  });

  it('re-arming after release drains stale tokens instead of stacking pools', () => {
    const stateDir = scratch();
    try {
      expect(armSharedJobserver({ mode: 'fifo', stateDir, tokens: 4 })).toBe(true);
      releaseSharedJobserver();
      expect(armSharedJobserver({ mode: 'fifo', stateDir, tokens: 2 })).toBe(true);
      expect(availableTokens(join(stateDir, jobserverFifoFileName))).toBe(2);
    } finally {
      releaseSharedJobserver();
      rmSync(stateDir, { force: true, recursive: true });
    }
  });

  it('injects nothing while unarmed', () => {
    expect(sharedJobserverDelta({})).toBeNull();
  });

  it('degrades to unarmed when the FIFO path holds a regular file', () => {
    // Models a platform where mkfifo is absent (win32, stripped containers):
    // whatever ends up at the path is not a FIFO, so arming reports failure
    // instead of throwing, and spawns keep their unarmed behavior.
    const stateDir = scratch();
    try {
      writeFileSync(join(stateDir, jobserverFifoFileName), 'not a fifo');
      expect(armSharedJobserver({ mode: 'fifo', stateDir, tokens: 2 })).toBe(false);
      expect(sharedJobserverDelta({})).toBeNull();
    } finally {
      rmSync(stateDir, { force: true, recursive: true });
    }
  });

  it('degrades to unarmed when the state dir cannot be created', () => {
    const root = scratch();
    try {
      const blocking = join(root, 'blocked');
      writeFileSync(blocking, '');
      // mkdirSync throws ENOTDIR/EEXIST here; arming must swallow it.
      expect(armSharedJobserver({ mode: 'fifo', stateDir: join(blocking, 'state'), tokens: 2 })).toBe(false);
      expect(sharedJobserverDelta({})).toBeNull();
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it('yields to explicit parallelism pinning and appends to plain MAKEFLAGS', () => {
    const stateDir = scratch();
    try {
      expect(armSharedJobserver({ mode: 'fifo', stateDir, tokens: 1 })).toBe(true);
      expect(sharedJobserverDelta({ CARGO_BUILD_JOBS: '4' })).toBeNull();
      expect(sharedJobserverDelta({ CARGO_MAKEFLAGS: '-j --jobserver-auth=fifo:/x' })).toBeNull();
      expect(sharedJobserverDelta({ MAKEFLAGS: '-j --jobserver-auth=fifo:/x' })).toBeNull();
      expect(sharedJobserverDelta({ MAKEFLAGS: '-w' })?.MAKEFLAGS).toMatch(
        /^-w -j --jobserver-auth=fifo:/u,
      );
    } finally {
      releaseSharedJobserver();
      rmSync(stateDir, { force: true, recursive: true });
    }
  });
});
