export type ReplayAudience =
  | { readonly kind: 'all' }
  | { readonly kind: 'identity' }
  | { readonly kind: 'package'; readonly packageName: string };

export interface ReplayChunk {
  readonly channel: 'stdout' | 'stderr';
  readonly data: Uint8Array;
  readonly encodedData: string;
  readonly audience: ReplayAudience;
}

export interface ReplaySnapshot {
  readonly chunks: readonly ReplayChunk[];
  readonly droppedBytes: number;
}

/**
 * Bounded in-memory copy of a leader's output so late attachers can replay
 * everything emitted before they arrived. On overflow the OLDEST chunks are
 * dropped (late attachers care most about recent diagnostics) and the
 * dropped-byte count is reported so the replay can be labeled truncated.
 */
export class ReplayBuffer {
  readonly #capacity: number;
  #chunks: ReplayChunk[] = [];
  #head = 0;
  #bytes = 0;
  #dropped = 0;

  constructor(capacityBytes: number) {
    this.#capacity = Math.max(0, capacityBytes);
  }

  push(
    channel: 'stdout' | 'stderr',
    data: Uint8Array,
    audience: ReplayAudience = { kind: 'all' },
    encodedData = Buffer.from(data).toString('base64'),
  ): void {
    if (data.byteLength === 0) {
      return;
    }
    if (this.#capacity === 0) {
      this.#dropped += data.byteLength;
      return;
    }
    this.#chunks.push({ channel, data: Buffer.from(data), encodedData, audience });
    this.#bytes += data.byteLength;
    while (this.#bytes > this.#capacity && this.#head < this.#chunks.length) {
      const oldest = this.#chunks[this.#head];
      if (oldest !== undefined) {
        this.#head += 1;
        this.#bytes -= oldest.data.byteLength;
        this.#dropped += oldest.data.byteLength;
      }
    }
    if (this.#head > 1_024 || this.#head * 2 >= this.#chunks.length) {
      this.#chunks = this.#chunks.slice(this.#head);
      this.#head = 0;
    }
  }

  snapshot(): ReplaySnapshot {
    return { chunks: this.#chunks.slice(this.#head), droppedBytes: this.#dropped };
  }
}
