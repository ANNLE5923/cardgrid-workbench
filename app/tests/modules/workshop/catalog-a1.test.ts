import test from 'node:test';
import assert from 'node:assert/strict';
import {validateWorkshopCatalog, parseWorkshopJson, validateWorkshopChange, type WorkshopCatalog, type WorkshopIssueCode} from '../../../src/workshop/model.ts';
import type {ActionCard as FrozenActionCard, BookEntry as FrozenBookEntry} from '../../../src/workspace/contracts-v3.ts';
import {actionCard, bookEntry, pool, rule, catalog} from './a1-fixtures.ts';

function valid(input: unknown): WorkshopCatalog {
  const result = validateWorkshopCatalog(input);
  assert.equal(result.ok, true, result.ok ? undefined : JSON.stringify(result.issues));
  if (!result.ok) throw new Error('Expected valid catalog');
  return result.value;
}
function invalid(input: unknown, code: WorkshopIssueCode, path?: string): void {
  const result = validateWorkshopCatalog(input); assert.equal(result.ok, false);
  if (result.ok) throw new Error('Expected invalid catalog');
  assert.ok(result.issues.some(issue => issue.code === code && (path === undefined || issue.path === path)), JSON.stringify(result.issues));
}
function changed(before: unknown, after: unknown, code?: WorkshopIssueCode): void {
  const result = validateWorkshopChange(before, after);
  assert.equal(result.ok, code === undefined, result.ok ? undefined : JSON.stringify(result.issues));
  if (code && !result.ok) assert.ok(result.issues.some(issue => issue.code === code), JSON.stringify(result.issues));
}

test('A1 empty workshop stays empty: no samples, rules, copies or instances are created', () => {
  const input = {actionCards: [], bookEntries: [], pools: [], generationRules: []};
  assert.deepEqual(valid(input), input); assert.deepEqual(input, {actionCards: [], bookEntries: [], pools: [], generationRules: []});
});
test('A1 reading + book and ordinary slot-free action use the exact C0 fields', () => {
  const result = valid(catalog());
  const action: FrozenActionCard = result.actionCards[0], book: FrozenBookEntry = result.bookEntries[0];
  assert.equal(action.slots[0].poolId, 'books'); assert.equal(book.author, null);
  assert.equal(result.actionCards[1].slots.length, 0);
  assert.deepEqual(Object.keys(result).sort(), ['actionCards', 'bookEntries', 'generationRules', 'pools']);
});
test('A1 validation preserves values and returns isolated immutable drafts', () => {
  const input = structuredClone(catalog());
  const before = structuredClone(input), result = valid(input);
  assert.deepEqual(input, before); assert.deepEqual(result, before);
  assert.notEqual(result.actionCards[0].content, input.actionCards[0].content);
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.actionCards[0].slots[0]));
  (input.actionCards[0].content as {title: string}).title = 'caller mutation';
  assert.equal(result.actionCards[0].content.title, '阅读《{书名}》');
  assert.throws(() => {(result.actionCards[0].content as {title: string}).title = 'invalid mutation';}, TypeError);
});
test('A1 forms and JSON pass through the same validator without coercion', () => {
  const input = catalog(); assert.deepEqual(parseWorkshopJson(JSON.stringify(input)), validateWorkshopCatalog(input));
  const bad = structuredClone(input) as any; bad.actionCards[0].slots[0].required = 'false';
  const fromForm = validateWorkshopCatalog(bad), fromJson = parseWorkshopJson(JSON.stringify(bad));
  assert.deepEqual(fromForm, fromJson); assert.equal(fromForm.ok, false);
  assert.equal(parseWorkshopJson('{').ok, false);
});
test('A1 malformed roots, missing collections and unknown format fields are rejected', () => {
  for (const root of [null, [], 'workshop', new Date()]) invalid(root, 'INVALID_SHAPE');
  invalid({actionCards: []}, 'MISSING_FIELD');
  invalid({...catalog(), dataFormat: 'action-v3'}, 'UNKNOWN_FIELD');
  invalid({...catalog(), dailyCopies: []}, 'UNKNOWN_FIELD');
});
test('A1 book fields do not acquire scheduling or completion semantics', () => {
  valid(catalog({bookEntries: [bookEntry({author: ''})]}));
  invalid(catalog({bookEntries: [{...bookEntry(), presetMinutes: 25} as any]}), 'UNKNOWN_FIELD', 'bookEntries[0].presetMinutes');
  invalid(catalog({bookEntries: [{...bookEntry(), completed: true} as any]}), 'UNKNOWN_FIELD');
  invalid(catalog({bookEntries: [bookEntry({title: '  '})]}), 'INVALID_VALUE', 'bookEntries[0].title');
  invalid(catalog({bookEntries: [{...bookEntry(), author: 42} as any]}), 'INVALID_VALUE', 'bookEntries[0].author');
});
test('A1 action Content retains existing duration and association snapshot rules', () => {
  valid(catalog({actionCards: [actionCard({content: {...actionCard().content, presetMinutes: null}}), catalog().actionCards[1]]}));
  for (const presetMinutes of [0, 7, 1445, NaN]) {
    invalid(catalog({actionCards: [actionCard({content: {...actionCard().content, presetMinutes}})]}), 'INVALID_VALUE', 'actionCards[0].content.presetMinutes');
  }
  invalid(catalog({actionCards: [actionCard({content: {...actionCard().content, projectIds: ['project-1'], projectLabels: []}})]}), 'INVALID_VALUE');
  invalid(catalog({actionCards: [actionCard({content: {...actionCard().content, color: 'green'}})]}), 'INVALID_VALUE');
});
test('A1 malformed nested arrays produce issues rather than crashing', () => {
  for (const patch of [{slots: null}, {content: {title: 'partial'}}, {source: []}])
    invalid(catalog({actionCards: [{...actionCard(), ...patch} as any]}), patch.content ? 'MISSING_FIELD' : 'INVALID_SHAPE');
  invalid(catalog({pools: [{...pool(), memberIds: null} as any]}), 'INVALID_SHAPE');
});

test('A1 sparse form arrays are rejected before reference projection can crash', () => {
  invalid(catalog({actionCards: new Array(1)}), 'INVALID_SHAPE', 'actionCards[0]');
  invalid(catalog({pools: new Array(1)}), 'INVALID_SHAPE', 'pools[0]');
  invalid(catalog({actionCards: [actionCard({slots: new Array(1)})]}), 'INVALID_SHAPE', 'actionCards[0].slots[0]');
  invalid(catalog({pools: [pool({memberIds: new Array(1)})]}), 'INVALID_SHAPE', 'pools[0].memberIds[0]');
});
test('A1 source shape follows C0, while full legacy reference resolution stays with workspace', () => {
  valid(catalog({actionCards: [actionCard({source: {kind: 'legacy', sourceId: 'outside-catalog', path: 'cards[0]'}}), catalog().actionCards[1]]}));
  invalid(catalog({bookEntries: [{...bookEntry(), source: {kind: 'manual', id: 'unexpected'}} as any]}), 'UNKNOWN_FIELD');
});
test('A1 duplicate entity ids and duplicate pool member ids are rejected', () => {
  invalid(catalog({bookEntries: [bookEntry(), bookEntry()]}), 'DUPLICATE_ID', 'bookEntries[1].id');
  invalid(catalog({pools: [pool({memberIds: ['book-1', 'book-1']})]}), 'DUPLICATE_ID', 'pools[0].memberIds[1]');
});
test('A1 identity namespaces allow an action and book to share text ids without mixing kinds', () => {
  const input = catalog({bookEntries: [bookEntry({id: 'reading'})], pools: [pool({memberIds: ['reading']}), pool({id: 'actions', poolKind: 'action', memberIds: ['reading']})]});
  valid(input);
});
test('A1 action and book pools reject members of the other kind', () => {
  invalid(catalog({pools: [pool({memberIds: ['walk']})]}), 'POOL_KIND_MISMATCH');
  invalid(catalog({pools: [pool(), pool({id: 'actions', poolKind: 'action', memberIds: ['book-1']})]}), 'POOL_KIND_MISMATCH');
});
test('A1 missing members and inventory ids are not silently treated as source cards', () => {
  invalid(catalog({pools: [pool({memberIds: ['missing']})]}), 'MISSING_REFERENCE');
  invalid(catalog({generationRules: [rule({actionCardId: 'copy-2026-10-04'})]}), 'MISSING_REFERENCE');
  invalid(catalog({generationRules: [rule({actionCardId: 'book-1'})]}), 'MISSING_REFERENCE');
});
test('A1 missing action parents and missing navigation parents are rejected', () => {
  invalid(catalog({actionCards: [actionCard({parentId: 'missing'})]}), 'MISSING_REFERENCE', 'actionCards[0].parentId');
  invalid(catalog({pools: [pool({parentPoolId: 'missing'})]}), 'MISSING_REFERENCE', 'pools[0].parentPoolId');
});
test('A1 action lineage rejects self and multi-node cycles', () => {
  invalid(catalog({actionCards: [actionCard({parentId: 'reading'})]}), 'HIERARCHY_CYCLE');
  invalid(catalog({actionCards: [actionCard({parentId: 'walk'}), actionCard({id: 'walk', parentId: 'reading', slots: []})]}), 'HIERARCHY_CYCLE');
});
test('A1 pool navigation rejects self and multi-node cycles', () => {
  invalid(catalog({pools: [pool({parentPoolId: 'books'})]}), 'HIERARCHY_CYCLE');
  invalid(catalog({pools: [pool({parentPoolId: 'second'}), pool({id: 'second', parentPoolId: 'books'})]}), 'HIERARCHY_CYCLE');
});
test('A1 navigation can cross pool kinds without becoming membership or a draw dependency', () => {
  valid(catalog({pools: [pool({parentPoolId: 'actions'}), pool({id: 'actions', poolKind: 'action', memberIds: ['reading']})]}));
});
test('A1 deep navigation is valid and a distant cycle is detected without recursion overflow', () => {
  const pools = Array.from({length: 2000}, (_, i) => pool({id: i === 0 ? 'books' : `p-${i}`, memberIds: [], parentPoolId: i === 1999 ? null : `p-${i + 1}`}));
  valid(catalog({pools}));
  invalid(catalog({pools: pools.map((p, i) => i === 1999 ? {...p, parentPoolId: 'books'} : p)}), 'HIERARCHY_CYCLE');
});
test('A1 duplicate slot ids are local to a card, not global between cards', () => {
  const slot = actionCard().slots[0];
  invalid(catalog({actionCards: [actionCard({slots: [slot, slot]})]}), 'DUPLICATE_ID');
  valid(catalog({actionCards: [actionCard(), actionCard({id: 'walk'})]}));
});
test('A1 concrete-entry slots reject missing pools and recursive action bindings', () => {
  const slot = actionCard().slots[0];
  invalid(catalog({actionCards: [actionCard({slots: [{...slot, poolId: 'missing'}]})]}), 'MISSING_REFERENCE');
  invalid(catalog({actionCards: [actionCard({slots: [{...slot, poolId: 'actions'}]})]}), 'SLOT_POOL_KIND_MISMATCH');
  invalid(catalog({actionCards: [actionCard({slots: [{...slot, valueKind: 'combo'} as any]})]}), 'INVALID_VALUE');
});
test('A1 empty and archived-only pools can be maintained even for required slots', () => {
  valid(catalog({pools: [pool({memberIds: []})]}));
  valid(catalog({bookEntries: [bookEntry({status: 'archived'})]}));
});
test('A1 weekday rules share the existing Sunday=0 convention and accept leap dates', () => {
  valid(catalog({generationRules: [rule({schedule: {mode: 'weekdays', weekdays: [0, 6]}, startDate: '2024-02-29'})]}));
});
test('A1 malformed schedules, empty weekdays, duplicates and invalid days are rejected', () => {
  for (const schedule of [{mode: 'daily', weekdays: [0]}, {mode: 'weekdays', weekdays: []}, {mode: 'weekdays', weekdays: [1, 1]}, {mode: 'weekdays', weekdays: [7]}, {mode: 'weekdays', weekdays: [1.5]}, {mode: 'monthly'}]) {
    const result = validateWorkshopCatalog(catalog({generationRules: [rule({schedule: schedule as any})]})); assert.equal(result.ok, false);
  }
});
test('A1 rule dates and zones reject impossible dates and fixed offsets', () => {
  invalid(catalog({generationRules: [rule({startDate: '2025-02-29'})]}), 'INVALID_VALUE', 'generationRules[0].startDate');
  invalid(catalog({generationRules: [rule({zone: '+08:00'})]}), 'INVALID_VALUE', 'generationRules[0].zone');
  invalid(catalog({generationRules: [rule({zone: 'Unknown/Zone'})]}), 'INVALID_VALUE');
});
test('A1 all entity versions are positive safe integers', () => {
  for (const version of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) invalid(catalog({bookEntries: [bookEntry({version})]}), 'INVALID_VALUE', 'bookEntries[0].version');
});
test('A1 changed fields require exactly one version increment; unchanged fields keep version', () => {
  const before = catalog(); changed(before, structuredClone(before));
  changed(before, {...before, bookEntries: [bookEntry({title: '新的书名'})]}, 'VERSION_CONFLICT');
  changed(before, {...before, bookEntries: [bookEntry({title: '新的书名', version: 2})]});
  changed(before, {...before, bookEntries: [bookEntry({title: '新的书名', version: 3})]}, 'VERSION_CONFLICT');
  changed(before, {...before, bookEntries: [bookEntry({version: 2})]}, 'VERSION_CONFLICT');
});
test('A1 creating a new object starts at version 1', () => {
  const before = catalog(); changed(before, {...before, bookEntries: [...before.bookEntries, bookEntry({id: 'new'})]});
  changed(before, {...before, bookEntries: [...before.bookEntries, bookEntry({id: 'new', version: 2})]}, 'VERSION_CONFLICT');
});
test('A1 stopping or archiving is a versioned edit and does not remove references', () => {
  const before = catalog();
  changed(before, {...before, bookEntries: [bookEntry({status: 'archived', version: 2})]});
  changed(before, {...before, generationRules: [rule({status: 'paused', version: 2})]});
  changed(before, {...before, actionCards: before.actionCards.map(card => ({...card, status: 'archived' as const, version: 2}))});
});
test('A1 existing sources and frozen rule zones cannot be replaced during editing', () => {
  const before = catalog();
  changed(before, {...before, bookEntries: [bookEntry({version: 2, source: {kind: 'capture', id: 'new-source'}})]}, 'SOURCE_CHANGED');
  changed(before, {...before, generationRules: [rule({version: 2, zone: 'America/New_York'})]}, 'RULE_ZONE_CHANGED');
});
test('A1 removal is rejected even when the remaining catalog has no broken references', () => {
  const before = catalog({generationRules: []});
  changed(before, {...before, actionCards: [before.actionCards[0]], pools: [before.pools[0]]}, 'DELETE_FORBIDDEN');
});
test('A1 old source snapshots stay unchanged when preparing a new source version', () => {
  const before = catalog(), original = structuredClone(before);
  const existingCopy = {actionCard: {id: 'reading', version: 1}, contentSnapshot: before.actionCards[0].content, slotSpecSnapshot: before.actionCards[0].slots};
  const copyBefore = structuredClone(existingCopy);
  const after = {...before, actionCards: before.actionCards.map(card => card.id === 'reading' ? {...card, version: 2, content: {...card.content, title: '阅读新模板'}} : card)};
  changed(before, after); assert.deepEqual(before, original); assert.deepEqual(existingCopy, copyBefore);
  const result = validateWorkshopChange(before, after); assert.equal(result.ok, true);
  if (result.ok) assert.notEqual(result.value.actionCards[0].content, existingCopy.contentSnapshot);
});
test('A1 invalid initial catalog is reported as before.*; no partial candidate is returned', () => {
  const result = validateWorkshopChange(null, catalog()); assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.issues[0].path, 'before.workshop');
});
