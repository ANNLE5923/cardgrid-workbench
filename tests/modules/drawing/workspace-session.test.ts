import test from 'node:test';
import assert from 'node:assert/strict';
import {harness, ok} from '../workspace/v3-fixtures.ts';
import {createWorkspaceDrawSession} from '../../../src/drawing/workspace-session.ts';

async function setup() {
  const h = harness(); await h.setup(); let randomCalls = 0, requests = 0;
  const drawing = createWorkspaceDrawSession(h.client, {id: () => `session-${++requests}`, random: () => {randomCalls++; return 0;}});
  await drawing.start();
  return {...h, drawing, calls: () => randomCalls};
}
async function combo(h: Awaited<ReturnType<typeof setup>>) {
  h.drawing.choose(h.drawing.getSnapshot().copies[0].id); h.drawing.reveal();
  await h.drawing.beginCombo(); await h.drawing.select('book', {mode:'manual',entryId:'book-1'});
}
test('production startup coordinates once; rereads and reopen do not create hand or reroll slots', async () => {
  const h = await setup(); const before = h.evidence();
  await h.drawing.coordinate(); await h.drawing.refresh();
  assert.deepEqual(h.evidence(), before); assert.equal((await h.data()).planner.instances.length, 0);
  await combo(h); const selection = h.drawing.getSnapshot().selections[0];
  await h.drawing.refresh(); assert.deepEqual(h.drawing.getSnapshot().selections[0], selection); assert.equal(h.calls(), 0);
  h.drawing.close();
});
test('sphere fixes the clicked identity; reveal and cancel never sample or write', async () => {
  const h = await setup(); await h.drawing.openSphere(); const before = h.evidence(), calls = h.calls();
  const id = h.drawing.getSnapshot().session.deck[0].id;
  h.drawing.present(id); h.drawing.reveal();
  assert.deepEqual(h.drawing.getSnapshot().session.phase, {kind:'revealed', copyId:id});
  assert.equal(h.calls(), calls); h.drawing.cancel(); assert.deepEqual(h.evidence(), before);
  h.drawing.close();
});
test('lost acceptance reply keeps command and concrete entry; retry replays once, new intention makes another instance', async () => {
  const h = await setup(); await combo(h); h.loseNextReply();
  assert.equal(await h.drawing.accept(), false); assert.equal(h.drawing.getSnapshot().canRetry, true);
  const committed = await h.data(); assert.equal(committed.planner.instances.length, 1);
  h.drawing.cancel(); assert.equal(h.drawing.getSnapshot().canRetry, true);
  assert.equal(await h.drawing.retry(), true); assert.deepEqual(await h.data(), committed);
  await combo(h); assert.equal(await h.drawing.accept(), true);
  const instances = (await h.data()).planner.instances;
  assert.equal(instances.length, 2); assert.notEqual(instances[0].id, instances[1].id);
  assert.equal(instances[0].daily?.sourceDate, instances[1].daily?.sourceDate); h.drawing.close();
});
test('manual supplement never backfills implicitly and rejects future or expired days', async () => {
  const h = await setup(); h.setNow('2026-10-07T04:00:00Z'); await h.drawing.coordinate();
  assert.deepEqual((await h.data()).dailyCopies.map(c => c.sourceDate), ['2026-10-04','2026-10-07']);
  assert.equal(await h.drawing.supplement('daily-reading','2026-10-06'), true);
  assert.ok((await h.data()).dailyCopies.some(c => c.sourceDate === '2026-10-06'));
  const before = h.evidence();
  assert.equal(await h.drawing.supplement('daily-reading','2026-10-08'), false);
  assert.equal(await h.drawing.supplement('daily-reading','2026-09-30'), false);
  assert.deepEqual(h.evidence(), before); h.drawing.close();
});

test('acceptance replay after expiry resumes deferred archive without duplicating the original action', async () => {
  const h=await setup();await combo(h);h.loseNextReply();assert.equal(await h.drawing.accept(),false);
  h.setNow('2026-10-11T04:00:00Z');assert.equal(await h.drawing.coordinate(),false);
  assert.equal(await h.drawing.retry(),true);const data=await h.data();
  assert.equal(data.planner.instances.length,1);assert.equal(data.planner.handOrder.length,0);
  assert.equal(data.archiveLogs.length,1);assert.deepEqual(data.dailyCopies.map(c=>c.sourceDate),['2026-10-11']);
  h.drawing.close();
});
test('expired copies archive at coordination; today deck never substitutes yesterday', async () => {
  const h = await setup(); await combo(h); await h.drawing.accept();
  h.setNow('2026-10-11T04:00:00Z'); await h.drawing.coordinate();
  const data = await h.data(); assert.equal(data.archiveLogs.length, 1);
  assert.equal(data.planner.handOrder.length, 0);
  await h.drawing.openSphere(); assert.deepEqual(h.drawing.getSnapshot().session.deck.map(c => c.sourceDate), ['2026-10-11']);
  const before = h.evidence(); assert.equal(await h.drawing.supplement('daily-reading','2026-10-04'), false);
  assert.deepEqual(h.evidence(), before); h.drawing.close();
});
test('failed generation is retryable without multiplying inventory or receipts', async () => {
  const h = harness(); await h.setup(); h.failNext();
  const drawing = createWorkspaceDrawSession(h.client, {id: () => 'failed-generation'});
  assert.equal(await drawing.start(), false); assert.equal(drawing.getSnapshot().canRetry, true);
  assert.equal((await h.data()).dailyCopies.length, 0);
  assert.equal(await drawing.retry(), true); assert.equal((await h.data()).dailyCopies.length, 1);
  assert.equal((await h.data()).commandReceipts.filter(r => r.commandId === 'failed-generation').length, 1);
  drawing.close();
});
