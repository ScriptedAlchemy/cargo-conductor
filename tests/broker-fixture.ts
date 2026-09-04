import { NodeServices } from '@effect/platform-node';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import type * as Scope from 'effect/Scope';

import { Broker, BrokerLive } from '../src/daemon/broker.js';
import { DaemonConfig } from '../src/daemon/config.js';
import { CostModel, createCostModel } from '../src/daemon/cost.js';
import { Ledger } from '../src/daemon/ledger.js';
import type { LedgerApi } from '../src/daemon/ledger.js';
import { Topology } from '../src/daemon/topology.js';

import { scopedFixture, scopedLedger } from './harness.js';
import type { Fixture } from './harness.js';

export interface BrokerFixture {
  readonly fixture: Fixture;
  readonly ledger: LedgerApi;
  readonly layer: Layer.Layer<Broker>;
}

/**
 * An in-process broker over the fake-cargo fixture. `wrapLedger` lets a test
 * inject delays or defects into individual ledger calls to force the timing
 * windows the daemon otherwise only hits under load.
 */
export const brokerFixture = (
  maxConcurrent: number,
  wrapLedger: (base: LedgerApi) => LedgerApi = (base) => base,
  env: Readonly<Record<string, string>> = {},
): Effect.Effect<BrokerFixture, never, Scope.Scope> =>
  Effect.gen(function* () {
    const fixture = yield* scopedFixture(maxConcurrent, env);
    const baseLedger = yield* scopedLedger(fixture.config);
    const ledger = wrapLedger(baseLedger);
    const costModel = createCostModel({
      kacheReader: null,
      seedDurations: baseLedger.recentDurations,
    });
    const layer = BrokerLive.pipe(
      Layer.provideMerge(Layer.succeed(CostModel, costModel)),
      Layer.provideMerge(
        Layer.succeed(Topology, {
          dependencyClosure: () => Effect.succeed(new Set<string>()),
          editedRecently: () => Effect.succeed(false),
        }),
      ),
      Layer.provideMerge(Layer.succeed(Ledger, ledger)),
      Layer.provideMerge(Layer.succeed(DaemonConfig, fixture.config)),
      Layer.provideMerge(NodeServices.layer),
    );
    return { fixture, ledger, layer };
  });
