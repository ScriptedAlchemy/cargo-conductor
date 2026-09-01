import { expect, it } from '@rstest/core';

import { conductorStateRoot } from '../src/status.js';

it('anchors daemon state under the shared cache root', () => {
  expect(conductorStateRoot).toBe('/fast/cache/cargo-conductor');
});
