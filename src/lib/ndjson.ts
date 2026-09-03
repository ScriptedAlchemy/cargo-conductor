export class LineBuffer {
  readonly #decoder = new TextDecoder();
  #pending = '';

  push(data: Uint8Array): string[] {
    const text = this.#pending + this.#decoder.decode(data, { stream: true });
    const lines: string[] = [];
    let start = 0;
    let newlineIndex = text.indexOf('\n', start);
    while (newlineIndex !== -1) {
      const line = text.slice(start, newlineIndex);
      if (line.trim().length > 0) {
        lines.push(line);
      }
      start = newlineIndex + 1;
      newlineIndex = text.indexOf('\n', start);
    }
    this.#pending = text.slice(start);
    return lines;
  }
}

export const parseJsonLines = (text: string): readonly unknown[] => {
  const parsed: unknown[] = [];
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) {
      continue;
    }
    try {
      parsed.push(JSON.parse(line));
    } catch {
      // Lenient readers ignore malformed records and keep scanning.
    }
  }
  return parsed;
};
