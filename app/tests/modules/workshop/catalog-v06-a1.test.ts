import assert from 'node:assert/strict';
import test from 'node:test';
import {assertValidCatalogV06, CatalogV06Error, MAX_DECK_MEMBERS, validateCatalogV06} from '../../../src/workshop/model.ts';
import type {CatalogV06} from '../../../src/workspace/v06.ts';
import {catalog as fixture} from '../../support/v06/fixtures.ts';

type DeepMutable<T> =
  T extends readonly (infer E)[] ? DeepMutable<E>[]
  : T extends object ? {-readonly [K in keyof T]: DeepMutable<T[K]>}
  : T;
const clone = (): DeepMutable<CatalogV06> => structuredClone(fixture) as DeepMutable<CatalogV06>;
const codes = (c: CatalogV06) => validateCatalogV06(c).issues.map(i => i.code);
const has = (c: CatalogV06, code: string) => codes(c).includes(code);

test('A1 constant: the direct-member limit is 100', () => {
  assert.equal(MAX_DECK_MEMBERS, 100);
});

test('A1 shared P0 fixture validates with zero issues', () => {
  const r = validateCatalogV06(clone());
  assert.equal(r.valid, true);
  assert.deepEqual(r.issues, []);
  assert.doesNotThrow(() => assertValidCatalogV06(clone()));
});

test('A1 allows unbound lists, shared candidates and shared owners', () => {
  const c = clone();
  const referenced = new Set(c.decisionCards.flatMap(d => d.deckIds));
  assert.equal(referenced.has('loose-list'), false); // unbound list
  assert.equal(referenced.has('empty-list'), false);
  assert.ok(c.decks.some(d => !referenced.has(d.id)));
  assert.equal(c.decisionCards.filter(d => d.deckIds.includes('books')).length, 2); // shared deck
  assert.equal(c.decisionCards.filter(d => d.ownerActionId === 'read').length, 2); // shared owner
  assert.equal(validateCatalogV06(c).valid, true);
});

test('A1 does not flag mappings against an empty candidate deck', () => {
  const c = clone();
  c.decisionCards.find(d => d.id === 'which-food')!.deckIds = ['empty-list'];
  assert.equal(validateCatalogV06(c).valid, true);
});

test('A1 rejects a broken deck member reference', () => {
  const c = clone();
  c.decks.find(d => d.id === 'books')!.memberIds = ['book-a', 'ghost'];
  assert.equal(has(c, 'BROKEN_MEMBER_REF'), true);
});

test('A1 rejects a member whose kind does not match the deck kind', () => {
  const c = clone();
  c.decks.find(d => d.id === 'books')!.memberIds = ['read']; // action id in an entry deck
  assert.equal(has(c, 'BROKEN_MEMBER_REF'), true);
});

test('A1 rejects duplicate members without a broken reference', () => {
  const c = clone();
  c.decks.find(d => d.id === 'books')!.memberIds = ['book-a', 'book-a'];
  assert.equal(has(c, 'DUPLICATE_MEMBER'), true);
  assert.equal(has(c, 'BROKEN_MEMBER_REF'), false);
});

test('A1 rejects a missing parent deck', () => {
  const c = clone();
  c.decks.find(d => d.id === 'books')!.parentDeckId = 'nope';
  assert.equal(has(c, 'BROKEN_PARENT_REF'), true);
});

test('A1 rejects a two-deck parent cycle, reporting each deck once', () => {
  const c = clone();
  c.decks.find(d => d.id === 'books')!.parentDeckId = 'foods';
  c.decks.find(d => d.id === 'foods')!.parentDeckId = 'books';
  const cycle = validateCatalogV06(c).issues.filter(i => i.code === 'PARENT_CYCLE');
  assert.deepEqual(cycle.map(i => i.path).sort(), ['decks[books].parentDeckId', 'decks[foods].parentDeckId']);
});

test('A1 rejects a self-referencing deck once', () => {
  const c = clone();
  c.decks.find(d => d.id === 'books')!.parentDeckId = 'books';
  const cycle = validateCatalogV06(c).issues.filter(i => i.code === 'PARENT_CYCLE');
  assert.equal(cycle.length, 1);
});

test('A1 rejects a decision whose owner action is missing', () => {
  const c = clone();
  c.decisionCards.find(d => d.id === 'which-food')!.ownerActionId = 'ghost';
  assert.equal(has(c, 'BROKEN_OWNER_REF'), true);
});

test('A1 rejects missing, duplicate or wrong-kind candidate decks', () => {
  let c = clone();
  c.decisionCards.find(d => d.id === 'which-food')!.deckIds = ['ghost'];
  assert.equal(has(c, 'BROKEN_DECK_REF'), true);

  c = clone();
  c.decisionCards.find(d => d.id === 'which-food')!.deckIds = ['foods', 'foods'];
  assert.equal(has(c, 'DUPLICATE_DECK_REF'), true);

  c = clone();
  c.decks.push({id: 'act-deck', version: 1, name: '行动堆', deckKind: 'action', parentDeckId: null, memberIds: ['read'], source: {kind: 'manual'}});
  c.decisionCards.find(d => d.id === 'which-food')!.deckIds = ['act-deck'];
  assert.equal(has(c, 'CANDIDATE_DECK_KIND'), true);
});

test('A1 rejects a mapping to a field the owner action does not declare', () => {
  const c = clone();
  c.decisionCards.find(d => d.id === 'which-food')!.mappings = [{fieldId: 'nope', entryPath: 'title'}];
  assert.equal(has(c, 'MAPPING_FIELD_UNKNOWN'), true);
});

test('A1 rejects duplicate mappings for the same field', () => {
  const c = clone();
  c.decisionCards.find(d => d.id === 'which-food')!.mappings = [
    {fieldId: 'subject', entryPath: 'title'},
    {fieldId: 'subject', entryPath: 'attributes.x'},
  ];
  assert.equal(has(c, 'DUPLICATE_MAPPING'), true);
});

test('A1 rejects an attribute path no candidate entry provides', () => {
  const c = clone();
  c.decisionCards.find(d => d.id === 'which-food')!.mappings = [{fieldId: 'subject', entryPath: 'attributes.author'}];
  assert.equal(has(c, 'MAPPING_PATH_UNRESOLVABLE'), true);
});

test('A1 resolves an attribute path when at least one candidate provides it', () => {
  const c = clone();
  c.actionCards.find(a => a.id === 'read')!.fields = [
    ...c.actionCards.find(a => a.id === 'read')!.fields,
    {id: 'authorName', label: '作者', valueType: 'text', required: false},
  ];
  c.decisionCards.find(d => d.id === 'which-book')!.mappings = [
    {fieldId: 'subject', entryPath: 'title'},
    {fieldId: 'authorName', entryPath: 'attributes.author'},
  ];
  assert.equal(validateCatalogV06(c).valid, true);
});

test('A1 rejects type mismatches between mapped values and field specs', () => {
  let c = clone();
  c.actionCards.find(a => a.id === 'meal')!.fields = [{id: 'count', label: '数量', valueType: 'number', required: false}];
  c.decisionCards.find(d => d.id === 'which-food')!.mappings = [{fieldId: 'count', entryPath: 'title'}];
  assert.equal(has(c, 'MAPPING_TYPE_MISMATCH'), true);

  c = clone();
  c.actionCards.find(a => a.id === 'train')!.fields = [{id: 'label', label: '标签', valueType: 'text', required: false}];
  c.decisionCards.find(d => d.id === 'which-exercise')!.mappings = [{fieldId: 'label', entryPath: 'attributes.minutes'}];
  assert.equal(has(c, 'MAPPING_TYPE_MISMATCH'), true);
});

test('A1 flags 101 real members as capacity exceeded without broken refs', () => {
  const c = clone();
  const made = Array.from({length: 101}, (_, i) => ({
    id: `bulk-${i}`, version: 1, title: `条目${i}`, attributes: {}, url: null, status: 'active' as const, source: {kind: 'manual' as const},
  }));
  c.catalogEntries.push(...made);
  c.decks.find(d => d.id === 'empty-list')!.memberIds = made.map(e => e.id);
  const r = validateCatalogV06(c);
  assert.equal(r.issues.some(i => i.code === 'CAPACITY_EXCEEDED'), true);
  assert.equal(r.issues.some(i => i.code === 'BROKEN_MEMBER_REF'), false);
});

test('A1 rejects duplicate ids within a collection', () => {
  const c = clone();
  c.catalogEntries.push({...c.catalogEntries[0], id: 'book-a'});
  assert.equal(has(c, 'DUPLICATE_ID'), true);
});

test('A1 assertValidCatalogV06 throws CatalogV06Error carrying issues', () => {
  const c = clone();
  c.decisionCards.find(d => d.id === 'which-food')!.ownerActionId = 'ghost';
  assert.throws(
    () => assertValidCatalogV06(c),
    (e: unknown) => e instanceof CatalogV06Error && e.issues.some(i => i.code === 'BROKEN_OWNER_REF'),
  );
});
