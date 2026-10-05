import test from 'node:test';
import assert from 'node:assert/strict';
import {harness,rule} from '../workspace/v3-fixtures.ts';
import {inventoryBoundary} from '../../../src/app/inventory-boundary.ts';

test('foreground wake-up uses frozen rule zone rather than device or browsed date', async () => {
  const h=harness(); await h.setup(); const data=await h.data();
  assert.equal(inventoryBoundary(data,'2026-10-04T04:00:00Z'),'2026-10-04T16:00:00Z');
  assert.equal(inventoryBoundary(null,'2026-10-04T04:00:00Z'),null);
});
test('day boundary respects 23-hour and 25-hour DST dates and earliest of multiple zones', async () => {
  const h=harness(); await h.setup(); const data=await h.data(); data.generationRules=[rule({zone:'America/New_York'})];
  assert.equal(inventoryBoundary(data,'2026-03-08T05:00:00Z'),'2026-03-09T04:00:00Z');
  assert.equal(inventoryBoundary(data,'2026-11-01T04:00:00Z'),'2026-11-02T05:00:00Z');
  data.generationRules.push(rule({id:'shanghai',zone:'Asia/Shanghai'}));
  assert.equal(inventoryBoundary(data,'2026-11-01T04:00:00Z'),'2026-11-01T16:00:00Z');
});
test('paused rules still wake for live inventory expiry, but dormant rules need no timer', async () => {
  const h=harness(); await h.setup(); await h.generate(); const data=await h.data(); data.generationRules[0].status='paused';
  assert.equal(inventoryBoundary(data,'2026-10-04T04:00:00Z'),'2026-10-04T16:00:00Z');
  data.dailyCopies=[]; assert.equal(inventoryBoundary(data,'2026-10-04T04:00:00Z'),null);
});
