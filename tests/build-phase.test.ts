import { describe, expect, it } from 'effect-rstest';

import {
  createBuildPhaseDetector,
  executionSubcommands,
  isCargoFinishedLine,
} from '../src/daemon/build-phase.js';

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const esc = String.fromCharCode(27);

describe('isCargoFinishedLine', () => {
  it('matches both spellings of the build-finished line, colored or plain', () => {
    expect(
      isCargoFinishedLine('    Finished `test` profile [unoptimized + debuginfo] target(s) in 1.23s'),
    ).toBe(true);
    expect(isCargoFinishedLine('    Finished test [unoptimized + debuginfo] target(s) in 1.23s')).toBe(
      true,
    );
    expect(isCargoFinishedLine('    Finished release [optimized] target(s) in 12.30s')).toBe(true);
    expect(
      isCargoFinishedLine(
        `${esc}[1m${esc}[32m    Finished${esc}[0m \`dev\` profile [unoptimized + debuginfo] target(s) in 0.05s`,
      ),
    ).toBe(true);
  });

  it('ignores test-harness summaries and other lookalikes', () => {
    expect(isCargoFinishedLine('test result: ok. 3 passed; 0 failed; finished in 0.01s')).toBe(false);
    expect(isCargoFinishedLine('Finished')).toBe(false);
    expect(isCargoFinishedLine('   Finished running 3 tests')).toBe(false);
    expect(isCargoFinishedLine('     Running unittests src/lib.rs (target/debug/deps/a-1)')).toBe(false);
    expect(isCargoFinishedLine('warning: Finished [x] target(s)')).toBe(false);
  });
});

describe('createBuildPhaseDetector', () => {
  it('fires once, on the chunk that completes the line, across split chunks', () => {
    const detector = createBuildPhaseDetector();
    expect(detector.feed('stderr', bytes('   Compiling a v0.1.0\n    Finished `test` pro'))).toBe(false);
    expect(detector.detected()).toBe(false);
    expect(
      detector.feed(
        'stderr',
        bytes('file [unoptimized + debuginfo] target(s) in 0.4s\n     Running unittests\n'),
      ),
    ).toBe(true);
    expect(detector.detected()).toBe(true);
    expect(
      detector.feed('stderr', bytes('    Finished `test` profile [unoptimized] target(s) in 0.1s\n')),
    ).toBe(false);
  });

  it('scans stdout as well, for callers that merged the streams', () => {
    const detector = createBuildPhaseDetector();
    expect(
      detector.feed('stdout', bytes('    Finished dev [unoptimized + debuginfo] target(s) in 0.4s\n')),
    ).toBe(true);
  });

  it('bounds the retained partial line and still recognizes a later real line', () => {
    const detector = createBuildPhaseDetector();
    expect(detector.feed('stderr', bytes('x'.repeat(10_000)))).toBe(false);
    expect(detector.feed('stderr', bytes(' Finished dev [x] target(s) in 1s'))).toBe(false);
    expect(detector.feed('stderr', bytes('\n'))).toBe(false);
    expect(
      detector.feed('stderr', bytes('    Finished dev [unoptimized] target(s) in 1s\n')),
    ).toBe(true);
  });

  it('keeps a multi-byte character split across chunks intact', () => {
    const detector = createBuildPhaseDetector();
    const accented = bytes('   Compiling café v1.0.0\n');
    const splitAt = accented.length - 8;
    expect(detector.feed('stderr', accented.slice(0, splitAt))).toBe(false);
    expect(
      detector.feed(
        'stderr',
        new Uint8Array([
          ...accented.slice(splitAt),
          ...bytes('    Finished dev [unoptimized] target(s) in 1s\n'),
        ]),
      ),
    ).toBe(true);
  });
});

describe('executionSubcommands', () => {
  it('names the subcommands that run user code after building', () => {
    expect([...executionSubcommands].sort()).toEqual(['bench', 'nextest', 'run', 'test']);
  });
});
