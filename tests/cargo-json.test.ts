import { describe, expect, it } from 'effect-rstest';

import { hasLibKind, packageNameFromId, parseCargoJsonLine } from '../src/daemon/cargo-json.js';

describe('packageNameFromId', () => {
  it('parses spec-url package ids', () => {
    expect(packageNameFromId('path+file:///srv/projects/tracedecay#tracedecay-core@0.1.0')).toBe(
      'tracedecay-core',
    );
    expect(packageNameFromId('registry+https://github.com/rust-lang/crates.io-index#serde@1.0.219')).toBe(
      'serde',
    );
  });

  it('parses spec urls whose fragment is only a version', () => {
    expect(packageNameFromId('path+file:///repo/crates/tracedecay#0.1.0')).toBe('tracedecay');
  });

  it('parses legacy space-separated package ids', () => {
    expect(packageNameFromId('tracedecay 0.1.0 (path+file:///repo)')).toBe('tracedecay');
  });
});

describe('parseCargoJsonLine', () => {
  it('parses compiler-artifact events', () => {
    const event = parseCargoJsonLine(
      JSON.stringify({
        reason: 'compiler-artifact',
        package_id: 'path+file:///fx#aa@0.1.0',
        target: { kind: ['lib'], name: 'aa' },
        fresh: true,
      }),
    );
    expect(event).toEqual({
      kind: 'artifact',
      packageName: 'aa',
      targetKinds: ['lib'],
      fresh: true,
    });
  });

  it('parses compiler-message events with rendered diagnostics', () => {
    const event = parseCargoJsonLine(
      JSON.stringify({
        reason: 'compiler-message',
        package_id: 'path+file:///fx#bb@0.1.0',
        target: { kind: ['bin'], name: 'bb' },
        message: { rendered: 'error[E0999]: broken\n', level: 'error' },
      }),
    );
    expect(event).toEqual({
      kind: 'message',
      packageName: 'bb',
      targetKinds: ['bin'],
      level: 'error',
      rendered: 'error[E0999]: broken\n',
    });
  });

  it('parses build-finished and passes unknown reasons through as other', () => {
    expect(parseCargoJsonLine('{"reason":"build-finished","success":true}')).toEqual({
      kind: 'build-finished',
      success: true,
    });
    expect(parseCargoJsonLine('{"reason":"build-script-executed"}')).toEqual({ kind: 'other' });
  });

  it('returns null for non-JSON and JSON without a reason', () => {
    expect(parseCargoJsonLine('running 3 tests')).toBeNull();
    expect(parseCargoJsonLine('{"note":"no reason"}')).toBeNull();
    expect(parseCargoJsonLine('{broken json')).toBeNull();
  });
});

describe('hasLibKind', () => {
  it('recognizes lib-shaped kinds only', () => {
    expect(hasLibKind(['lib'])).toBe(true);
    expect(hasLibKind(['proc-macro'])).toBe(true);
    expect(hasLibKind(['rlib', 'dylib'])).toBe(true);
    expect(hasLibKind(['bin'])).toBe(false);
    expect(hasLibKind(['test', 'example'])).toBe(false);
    expect(hasLibKind([])).toBe(false);
  });
});
