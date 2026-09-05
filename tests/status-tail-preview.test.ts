import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'effect-rstest';
import * as Effect from 'effect/Effect';
import * as Schedule from 'effect/Schedule';

import { Broker } from '../src/daemon/broker.js';
import type { BrokerApi } from '../src/daemon/broker.js';
import {
  statusOutputPreviewBytes,
  statusOutputPreviewLines,
} from '../src/daemon/protocol.js';
import type { RequestRecord, StatusRow } from '../src/daemon/protocol.js';
import { statusReportSchema } from '../src/lib/protocol-schemas.js';

import { brokerFixture } from './broker-fixture.js';
import type { Fixture } from './harness.js';

const fullTailBytes = 16 * 1024;

const utf8Bytes = (text: string | null | undefined): number => Buffer.byteLength(text ?? '');

const lineCount = (text: string): number => text.replace(/\n$/u, '').split('\n').length;

const noopCallbacks = {
  onExit: () => Effect.void,
  onOutput: () => Effect.void,
  onStarted: () => Effect.void,
};

const awaitFullTail = (broker: BrokerApi, ticket: string): Effect.Effect<RequestRecord> =>
  broker.getTicket(ticket).pipe(
    Effect.flatMap((record) =>
      record !== null && record.status === 'running' && utf8Bytes(record.outputTail) >= fullTailBytes
        ? Effect.succeed(record)
        : Effect.fail(`tail not full yet for ${ticket}`),
    ),
    Effect.retry(Schedule.spaced('50 millis').pipe(Schedule.upTo({ times: 200 }))),
    Effect.orDie,
  );

const submitBulk = (
  broker: BrokerApi,
  fixture: Fixture,
  cwd: string,
  pkg: string,
  subcommand = 'check',
): Effect.Effect<string, unknown> =>
  broker
    .submit(
      {
        argv: ['cargo', subcommand, '-p', pkg],
        cwd,
        env: {
          CARGO_HAULER_CARGO_BIN: join(fixture.binDir, 'cargo'),
          FAKE_OUTPUT_BYTES: String(fullTailBytes + 4_096),
          FAKE_SLEEP: '20',
        },
      },
      noopCallbacks,
    )
    .pipe(Effect.map((submitted) => submitted.ticket));

const expectSummaryShape = (row: StatusRow): void => {
  expect(row).not.toHaveProperty('outputTail');
  expect(row).not.toHaveProperty('outputTailLive');
  expect(row).not.toHaveProperty('outputTailPreview');
};

describe('status report live-tail preview (#95)', () => {
  it.live(
    'keeps status rows bounded while detail reads retain the whole live and settled tail',
    () =>
      Effect.gen(function* () {
        const { fixture, layer } = yield* brokerFixture(1);
        yield* Effect.scoped(
          Effect.gen(function* () {
            const broker = yield* Broker;
            const runningTicket = yield* submitBulk(broker, fixture, fixture.ws1, 'preview');
            const queuedTicket = yield* submitBulk(broker, fixture, fixture.ws1, 'queued', 'test');
            const live = yield* awaitFullTail(broker, runningTicket);
            const fullTail = live.outputTail ?? '';

            expect(utf8Bytes(fullTail)).toBe(fullTailBytes);
            expect(live.outputTailLive).toBe(true);

            const report = yield* broker.report();
            const wireReport = { ...report, version: 'test' };
            const parsedReport = statusReportSchema.parse(wireReport);
            expect(parsedReport.active.map((row) => row.ticket)).toEqual(
              report.active.map((row) => row.ticket),
            );

            const running = report.active.find((row) => row.ticket === runningTicket);
            expect(running?.status).toBe('running');
            expectSummaryShape(running as StatusRow);
            const preview = running?.outputPreview ?? '';
            expect(preview.length).toBeGreaterThan(0);
            expect(utf8Bytes(preview)).toBeLessThanOrEqual(statusOutputPreviewBytes);
            expect(lineCount(preview)).toBeLessThanOrEqual(statusOutputPreviewLines);
            expect(fullTail.endsWith(preview)).toBe(true);
            const previewStart = fullTail.length - preview.length;
            expect(previewStart === 0 || fullTail[previewStart - 1] === '\n').toBe(true);

            const queued = report.active.find((row) => row.ticket === queuedTicket);
            expect(queued?.status).toBe('queued');
            expect(queued?.outputPreview).toBeNull();
            expectSummaryShape(queued as StatusRow);
            for (const row of report.recent) {
              expect(row.outputPreview).toBeNull();
              expectSummaryShape(row);
            }

            const fetched = yield* broker.getTicket(runningTicket);
            expect(fetched?.outputTail).toBe(fullTail);
            expect(fetched?.outputTailLive).toBe(true);

            yield* broker.kill(queuedTicket);
            yield* broker.kill(runningTicket);
            yield* broker.awaitTicket(queuedTicket, 10_000);
            yield* broker.awaitTicket(runningTicket, 10_000);

            const settledReport = yield* broker.report();
            const settled = settledReport.recent.find((row) => row.ticket === runningTicket);
            expect(settled?.outputPreview).toBeNull();
            expectSummaryShape(settled as StatusRow);
            const settledDetail = yield* broker.getTicket(runningTicket);
            expect(utf8Bytes(settledDetail?.outputTail)).toBeGreaterThan(8 * 1024);
            expect(settledDetail?.outputTailLive).toBeUndefined();
          }),
        ).pipe(Effect.provide(layer));
      }),
    30_000,
  );

  it.live(
    'bounds status payload size by running ticket count rather than full tail size',
    () =>
      Effect.gen(function* () {
        const runningCount = 4;
        const { fixture, layer } = yield* brokerFixture(runningCount);
        const workspaces = Array.from({ length: runningCount }, (_, index) => {
          const cwd = join(fixture.root, `bulk-ws${index}`);
          mkdirSync(cwd, { recursive: true });
          writeFileSync(join(cwd, 'Cargo.toml'), `[package]\nname = "bulk-ws${index}"\n`);
          return cwd;
        });

        yield* Effect.scoped(
          Effect.gen(function* () {
            const broker = yield* Broker;
            const tickets = yield* Effect.forEach(
              workspaces,
              (cwd, index) => submitBulk(broker, fixture, cwd, `bulk${index}`),
              { concurrency: 'unbounded' },
            );
            const details = yield* Effect.forEach(tickets, (ticket) => awaitFullTail(broker, ticket), {
              concurrency: 'unbounded',
            });
            for (const detail of details) {
              expect(utf8Bytes(detail.outputTail)).toBeGreaterThan(8 * 1024);
            }

            const report = yield* broker.report();
            const rows = report.active.filter((row) => tickets.includes(row.ticket));
            expect(rows).toHaveLength(runningCount);
            expect(utf8Bytes(JSON.stringify(rows)) / runningCount).toBeLessThan(4 * 1024);
            for (const row of rows) {
              expectSummaryShape(row);
              expect(utf8Bytes(row.outputPreview)).toBeLessThanOrEqual(statusOutputPreviewBytes);
            }

            yield* Effect.forEach(tickets, (ticket) => broker.kill(ticket), { discard: true });
            yield* Effect.forEach(tickets, (ticket) => broker.awaitTicket(ticket, 10_000), {
              discard: true,
            });
          }),
        ).pipe(Effect.provide(layer));
      }),
    60_000,
  );
});
