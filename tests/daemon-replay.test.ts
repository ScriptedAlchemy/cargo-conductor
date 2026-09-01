import { describe, expect, it } from '@rstest/core';

import { ReplayBuffer } from '../src/daemon/replay.js';

describe('ReplayBuffer', () => {
  it('preserves retained chunks and dropped-byte accounting after repeated overflow', () => {
    const replay = new ReplayBuffer(5);
    replay.push('stdout', Buffer.from('aa'), { kind: 'all' }, 'YWE=');
    replay.push('stderr', Buffer.from('bbb'), { kind: 'identity' }, 'YmJi');
    replay.push(
      'stdout',
      Buffer.from('cccc'),
      { kind: 'package', packageName: 'alpha' },
      'Y2NjYw==',
    );

    expect(replay.snapshot()).toEqual({
      chunks: [
        {
          audience: { kind: 'package', packageName: 'alpha' },
          channel: 'stdout',
          data: Buffer.from('cccc'),
          encodedData: 'Y2NjYw==',
        },
      ],
      droppedBytes: 5,
    });
  });

  it('keeps snapshot order after enough drops to trigger internal compaction', () => {
    const replay = new ReplayBuffer(3);
    for (let index = 0; index < 2_100; index += 1) {
      const value = String(index % 10);
      replay.push(
        'stdout',
        Buffer.from(value),
        { kind: 'all' },
        Buffer.from(value).toString('base64'),
      );
    }

    expect(replay.snapshot().chunks.map((chunk) => chunk.data.toString())).toEqual(['7', '8', '9']);
    expect(replay.snapshot().droppedBytes).toBe(2_097);
  });
});
