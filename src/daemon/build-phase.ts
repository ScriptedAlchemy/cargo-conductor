import { StringDecoder } from 'node:string_decoder';

import { stripAnsi } from '../lib/ansi.js';

/**
 * Subcommands whose cargo runs user code after the build. Cargo holds the
 * build-directory lock (`target/<profile>/.cargo-lock`) only while it
 * compiles: the `Layout` that owns the lock is dropped when compilation
 * returns, before test binaries, benches, or the program start. The lane
 * can therefore admit the next request's compile as soon as one of these
 * leaders reports its build finished, instead of holding the whole lane
 * through a test run that never touches the artifacts again.
 */
export const executionSubcommands: ReadonlySet<string> = new Set([
  'bench',
  'nextest',
  'run',
  'test',
]);

/**
 * Cargo's end-of-build status line, in both spellings:
 *   `    Finished \`test\` profile [unoptimized + debuginfo] target(s) in 1.2s`
 *   `    Finished test [unoptimized + debuginfo] target(s) in 1.2s`
 * `--quiet` suppresses it, in which case the lane simply stays held; a test
 * printing a lookalike would only let the next compile start early, which
 * cargo's own lock still serializes.
 */
const finishedLinePattern = /^\s*Finished\s+(?:`[^`]*`\s+profile\s+|[A-Za-z0-9_.-]+\s+)?\[[^\]]*\]\s+target\(s\)/u;

/** Bytes of an unterminated line retained between chunks. */
const maxPartialLength = 4_096;

export const isCargoFinishedLine = (line: string): boolean =>
  finishedLinePattern.test(stripAnsi(line));

export interface BuildPhaseDetector {
  /**
   * Feeds one raw output chunk; true exactly once, on the chunk that
   * completes the build-finished line. Both channels are scanned: a caller
   * that merged stderr into stdout delivers cargo's status lines there.
   */
  readonly feed: (channel: 'stdout' | 'stderr', data: Uint8Array) => boolean;
  readonly detected: () => boolean;
}

export const createBuildPhaseDetector = (): BuildPhaseDetector => {
  const decoder = new StringDecoder('utf8');
  let partial = '';
  let detected = false;
  return {
    detected: () => detected,
    feed: (_channel, data) => {
      if (detected) {
        return false;
      }
      partial += decoder.write(Buffer.from(data));
      let newline = partial.indexOf('\n');
      while (newline !== -1) {
        const line = partial.slice(0, newline);
        partial = partial.slice(newline + 1);
        if (isCargoFinishedLine(line)) {
          detected = true;
          partial = '';
          return true;
        }
        newline = partial.indexOf('\n');
      }
      if (partial.length > maxPartialLength) {
        partial = partial.slice(-maxPartialLength);
      }
      return false;
    },
  };
};
