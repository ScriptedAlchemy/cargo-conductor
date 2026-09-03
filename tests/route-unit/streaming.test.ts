import type { AgentDocument, AgentRenderEvent } from '@agent-bundle/runtime';
import { describe, expect, it } from 'effect-rstest';
import { expectDocument, expectEvents, renderRouteEvents } from 'agent-bundle/test';
import * as Effect from 'effect/Effect';

import { requestOverSocket } from '../../src/daemon/control.js';
import { scopedDaemon, type Fixture } from '../harness.js';

import { fakeCargoEnv, withDaemon, withIsolatedStateDir } from './support.js';

/**
 * Streaming proof: `hauler_await` and `hauler_log` are progressive documents.
 * The Suspense fallback is what a reader sees while the daemon works — the
 * live ticket card and a progress node, or a "reading the ledger" progress
 * frame — and the settled document replaces it with the ordinary result whose
 * value the runtime merges up through the layout and the stream container.
 */
const intermediateDocuments = (events: readonly AgentRenderEvent[]): readonly AgentDocument[] =>
  events.flatMap((event) => {
    switch (event.type) {
      case 'shell':
      case 'replace':
        return [event.document];
      case 'complete':
      case 'error':
      case 'progress':
        return [];
      default: {
        const exhaustive: never = event;
        throw new Error(`Unhandled render event: ${JSON.stringify(exhaustive)}`);
      }
    }
  });

const documentText = (document: AgentDocument): string => JSON.stringify(document.root);

const submitSlowJob = (fixture: Fixture) =>
  Effect.gen(function* () {
    const ack = yield* requestOverSocket({
      isTerminal: (message) => message.type === 'ack' || message.type === 'error',
      message: {
        argv: ['cargo', 'check', '-p', 'ws1'],
        background: true,
        cwd: fixture.ws1,
        env: { ...fakeCargoEnv(fixture.binDir), FAKE_SLEEP: '2' },
        host: 'streaming',
        id: 'streaming-1',
        session: 's-stream',
        type: 'exec',
      },
      socketPath: fixture.config.socketPath,
      timeoutMs: 8_000,
    });
    const acked = ack.find((message) => message.type === 'ack');
    if (acked === undefined || acked.type !== 'ack') {
      throw new Error(`daemon did not ack: ${JSON.stringify(ack)}`);
    }
    return acked.ticket;
  });

describe('progressive documents', () => {
  it('streams a progress frame for the log read before the ledger listing', async () => {
    await withIsolatedStateDir(async () => {
      const rendered = await renderRouteEvents('tool:hauler/hauler_log', { input: { limit: 3 } });
      const pending = intermediateDocuments(rendered.events).filter((document) =>
        documentText(document).includes('"kind":"progress"') && documentText(document).includes('reading the ledger'));
      expect(pending.length).toBeGreaterThan(0);
      expectEvents(rendered).toCompleteOnce().toHaveNoErrors();
      expectDocument(rendered).toHaveStatus('success').toContainText('no hauler requests recorded');
      expect(rendered.result).toMatchObject({ operation: 'log', requests: [] });
      expect(rendered.document.value).toEqual(rendered.result);
    });
  });

  it.live('streams the live ticket card while awaiting, then the settled ticket with its value', () =>
    Effect.gen(function* () {
      const fixture = yield* scopedDaemon(1);
      const ticket = yield* submitSlowJob(fixture);
      yield* Effect.promise(async () => {
        const daemon = await withDaemon(fixture.config);
        const rendered = await renderRouteEvents('tool:hauler/hauler_await', {
          ...daemon,
          input: { maxWaitMs: 20_000, ticket },
        });
        const pending = intermediateDocuments(rendered.events).filter((document) =>
          documentText(document).includes(`Waiting up to 20.0s for ${ticket}`));
        expect(pending.length).toBeGreaterThan(0);
        // The fallback carries the live card and a progress node…
        expect(pending.some((document) => documentText(document).includes('"kind":"progress"'))).toBe(true);
        expect(pending.some((document) => documentText(document).includes(`### ${ticket}`))).toBe(true);
        // …and the settled document replaces it with the finished ticket and the merged value.
        expectEvents(rendered).toCompleteOnce().toHaveNoErrors();
        expectDocument(rendered)
          .toHaveStatus('success')
          .toContainText(`${ticket} done`)
          .toContainContext(`${ticket} succeeded`);
        expect(JSON.stringify(rendered.document.root)).not.toContain('Waiting up to');
        expect(rendered.result).toMatchObject({ operation: 'await', request: { status: 'done' }, ticket, timedOut: false });
        expect(rendered.document.value).toEqual(rendered.result);
      });
    }), 40_000);

  it.live('reports an expired wait as a settled document, not a failure', () =>
    Effect.gen(function* () {
      const fixture = yield* scopedDaemon(1);
      const ticket = yield* submitSlowJob(fixture);
      yield* Effect.promise(async () => {
        const daemon = await withDaemon(fixture.config);
        const rendered = await renderRouteEvents('tool:hauler/hauler_await', {
          ...daemon,
          input: { maxWaitMs: 200, ticket },
        });
        expectDocument(rendered)
          .toHaveStatus('success')
          .toContainText(`${ticket} still pending`)
          .toContainContext('wait expired');
        expect(rendered.result).toMatchObject({ operation: 'await', ticket, timedOut: true });
      });
    }), 40_000);
});
