import { describe, expect, it } from 'effect-rstest';
import * as Socket from 'effect/unstable/socket/Socket';

import { mapSocketFailure, openTimeoutMs } from '../src/daemon/control.js';

const socketPath = '/tmp/hauler-control-test.sock';

const openError = (kind: 'Timeout' | 'Unknown', cause: unknown): Socket.SocketError =>
  new Socket.SocketError({ reason: new Socket.SocketOpenError({ cause, kind }) });

describe('mapSocketFailure', () => {
  it('reads a refused or absent socket as a stopped daemon', () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    const mapped = mapSocketFailure(openError('Unknown', refused), socketPath);
    expect(mapped._tag).toBe('DaemonUnreachable');
  });

  it('reads an accept that never arrives as a slow daemon, not a stopped one', () => {
    const mapped = mapSocketFailure(openError('Timeout', undefined), socketPath);
    expect(mapped._tag).toBe('ControlTimeout');
    if (mapped._tag === 'ControlTimeout') {
      expect(mapped.timeoutMs).toBe(openTimeoutMs);
      expect(mapped.received).toEqual([]);
    }
  });

  it('reads read and write failures as a closed connection carrying what arrived', () => {
    const pong = { id: 'x', pid: 1, startedAtMs: 0, type: 'pong' as const, version: '0' };
    const mapped = mapSocketFailure(
      new Socket.SocketError({ reason: new Socket.SocketReadError({ cause: new Error('reset') }) }),
      socketPath,
      [pong],
    );
    expect(mapped._tag).toBe('ConnectionClosed');
    if (mapped._tag === 'ConnectionClosed') {
      expect(mapped.received).toEqual([pong]);
    }
  });
});
