import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareWorkshopChange, workshopChangeEffectiveDate, type PreparedWorkshopChange} from '../../../src/workshop/model.ts';
import {catalog, actionCard, rule, bookEntry, pool} from './a1-fixtures.ts';

const at = '2026-10-04T16:30:00Z';
function prepared(before: unknown, after: unknown): PreparedWorkshopChange {
  const result = prepareWorkshopChange(before, after, {at});
  assert.equal(result.ok, true, result.ok ? undefined : JSON.stringify(result.issues));
  if (!result.ok) throw new Error('Expected prepared change');
  return result.value;
}

test('A1 save preparation captures only changed versions and creation, without modifying either input', () => {
  const before = catalog(), original = structuredClone(before);
  const after = catalog({actionCards: [actionCard({version: 2, content: {...actionCard().content, title: '新标题'}}), before.actionCards[1]],
    bookEntries: [bookEntry(), bookEntry({id: 'book-2', title: '新书'})]});
  const candidate = structuredClone(after), result = prepared(before, after);
  assert.deepEqual(before, original); assert.deepEqual(after, candidate);
  assert.equal(result.at, at); assert.deepEqual(result.catalog, after);
  assert.deepEqual(result.revisions.map(revision => [revision.collection, revision.before?.version ?? null, revision.after.id, revision.after.version]),
    [['actionCards', 1, 'reading', 2], ['bookEntries', null, 'book-2', 1]]);
  assert.ok(Object.isFrozen(result.revisions[0].before));
  assert.ok(Object.isFrozen(result.revisions[0].after));
});

test('A1 unchanged save has no new revision or implicit version bump', () => {
  const input = catalog(); assert.deepEqual(prepared(input, input).revisions, []);
});

test('A1 same command instant starts each new version on that rule zone current date', () => {
  const result = prepared(catalog(), catalog({generationRules: [rule({version: 2, name: '改名'})]}));
  assert.equal(workshopChangeEffectiveDate(result, 'Asia/Shanghai'), '2026-10-05');
  assert.equal(workshopChangeEffectiveDate(result, 'America/Los_Angeles'), '2026-10-04');
  assert.equal(workshopChangeEffectiveDate({at: '2026-10-04T15:59:59Z'}, 'Asia/Shanghai'), '2026-10-04');
  assert.equal(workshopChangeEffectiveDate({at: '2026-10-04T16:00:00Z'}, 'Asia/Shanghai'), '2026-10-05');
});

test('A1 UI cannot request future or backdated effectivity through save context', () => {
  for (const effectiveDate of ['2026-10-03', '2026-10-06']) {
    const result = prepareWorkshopChange(catalog(), catalog(), {at, effectiveDate});
    assert.equal(result.ok, false);
    if (!result.ok) assert.ok(result.issues.some(issue => issue.code === 'UNKNOWN_FIELD' && issue.path === 'context.effectiveDate'));
  }
  for (const context of [null, {}, {at: '2026-10-04'}, {at: '2026-10-04T24:00:00Z'}, {at: '2026-10-04T18:00:00+08:00'}]) {
    assert.equal(prepareWorkshopChange(catalog(), catalog(), context).ok, false);
  }
});

test('A1 change plan preserves old content, slot binding and rule schedule evidence after caller edits', () => {
  const before = structuredClone(catalog());
  const after = catalog({actionCards: [actionCard({version: 2, slots: []}), before.actionCards[1]],
    generationRules: [rule({version: 2, schedule: {mode: 'weekdays', weekdays: [1, 3]}})]});
  const result = prepared(before, after);
  (before.actionCards[0].slots[0] as {poolId: string}).poolId = 'caller-mutation';
  const actionRevision = result.revisions.find(revision => revision.collection === 'actionCards');
  const ruleRevision = result.revisions.find(revision => revision.collection === 'generationRules');
  assert.equal(actionRevision?.before?.slots[0].poolId, 'books');
  assert.deepEqual(actionRevision?.after.slots, []);
  assert.deepEqual(ruleRevision?.before?.schedule, {mode: 'daily'});
  assert.deepEqual(ruleRevision?.after.schedule, {mode: 'weekdays', weekdays: [1, 3]});
});

test('A1 all four workshop object kinds provide before/after versions through one save seam', () => {
  const before = catalog();
  const after = catalog({actionCards: [actionCard({version: 2, status: 'paused'}), before.actionCards[1]],
    bookEntries: [bookEntry({version: 2, status: 'archived'})],
    pools: [pool({version: 2, name: '重命名'}), before.pools[1]],
    generationRules: [rule({version: 2, status: 'paused'})]});
  const result = prepared(before, after);
  assert.deepEqual(result.revisions.map(revision => revision.collection), ['actionCards', 'bookEntries', 'pools', 'generationRules']);
  assert.equal(prepareWorkshopChange(before, catalog({bookEntries: [bookEntry({title: '忘记增加版本'})]}), {at}).ok, false);
});
