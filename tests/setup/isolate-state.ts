import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Every worker gets its own empty state directory so hook recorders, ledger
// probes, and daemon cold-starts can never touch the developer's live broker
// (test rows were showing up in the production dashboard).
if (process.env.CARGO_HAULER_STATE_DIR === undefined) {
  process.env.CARGO_HAULER_STATE_DIR = mkdtempSync(join(tmpdir(), 'cargo-hauler-test-'));
}
process.env.CARGO_HAULER_KACHE_INDEX = '';
