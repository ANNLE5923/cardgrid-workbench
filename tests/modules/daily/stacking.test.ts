import test from 'node:test';
import assert from 'node:assert/strict';
import {harness} from '../workspace/v3-fixtures.ts';
import {groupHand} from '../../../src/daily/hand/stacking.ts';

test('stacking preserves independent dated members and excludes selection timestamps from visual grouping', async () => {
  const h = harness(); await h.setup(); await h.generate(); await h.accept();
  h.setNow('2026-10-05T04:00:00Z'); const later = await h.generate(); await h.accept(later);
  await h.accept((await h.data()).dailyCopies.find(copy=>copy.id===later.id)!);
  const data = await h.data(), hand = data.planner.instances, before = structuredClone(data);
  const groups = groupHand(hand, data);
  assert.equal(groups.length, 1); assert.equal(groups[0].members.length, 3);
  assert.equal(new Set(groups[0].members.map(i => i.id)).size, 3);
  assert.deepEqual(groups[0].members.map(i => i.daily?.sourceDate), ['2026-10-04','2026-10-05','2026-10-05']);
  assert.deepEqual(data, before);
});
test('stacking separates original version, final content and source rule while legacy hand remains individual', async () => {
  const h = harness(); await h.setup(); const copy = await h.generate(); await h.accept(copy); await h.accept();
  const data = await h.data(), [a,b] = data.planner.instances;
  b.currentContent = {...b.currentContent,criteria:'不同完成标准'};
  assert.equal(groupHand([a,b], data).length, 2);
  b.currentContent = structuredClone(a.currentContent); b.daily = undefined;
  assert.equal(groupHand([a,b], data).length, 2);
  b.daily = structuredClone(a.daily);
  const secondCopy = {...data.dailyCopies[0],id:'another-copy',actionCard:{...data.dailyCopies[0].actionCard,version:2}};
  data.dailyCopies.push(secondCopy); b.daily!.copyId = secondCopy.id;
  assert.equal(groupHand([a,b], data).length, 2);
  secondCopy.actionCard = {...copy.actionCard}; secondCopy.ruleId = 'another-rule';
  assert.equal(groupHand([a,b], data).length, 2);
});
test('deliberate repeated acceptance may exceed seven; display does not cap or merge identities', async () => {
  const h = harness(); await h.setup(); await h.generate();
  for (let i=0;i<9;i++) await h.accept();
  const data = await h.data(), groups = groupHand(data.planner.instances,data);
  assert.equal(groups[0].members.length,9); assert.equal(data.planner.handOrder.length,9);
});
