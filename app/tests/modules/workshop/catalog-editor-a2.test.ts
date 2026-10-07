import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  CatalogEntry, CatalogV06, DecisionCard, Deck,
} from '../../../src/workspace/v06.ts';
import {createInMemoryCatalogEditor, type CatalogEditorHost, type EditorResult} from '../../../src/workshop/catalog-editor.ts';
import {catalog as fixture, AT} from '../../support/v06/fixtures.ts';

const makeHost = (): CatalogEditorHost =>
  createInMemoryCatalogEditor(structuredClone(fixture), {now: () => AT});
const must = <T,>(r: EditorResult<T>): T => {
  if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
  return r.value;
};
const entryDraft = (id: string, patch: Partial<CatalogEntry> = {}): CatalogEntry =>
  ({id, version: 1, title: id, attributes: {}, url: null, status: 'active', source: {kind: 'manual'}, ...patch});
const deckDraft = (id: string, patch: Partial<Deck> = {}): Deck =>
  ({id, version: 1, name: id, deckKind: 'entry', parentDeckId: null, memberIds: [], source: {kind: 'manual'}, ...patch});

test('A2 readCatalog returns a detached snapshot', async () => {
  const host = makeHost();
  const first = must(await host.readCatalog());
  (first.data.catalogEntries as CatalogEntry[]).push(entryDraft('mutated'));
  const second = must(await host.readCatalog());
  assert.equal(second.data.catalogEntries.length, fixture.catalogEntries.length);
});

test('A2 stamp marks an in-memory draft adapter', async () => {
  const host = makeHost();
  assert.deepEqual(host.stamp, {contractVersion: 'v06-p0-1', backend: 'test-adapter', release: 'draft'});
});

test('A2 creates an entry with a null expected version and bumps revision', async () => {
  const host = makeHost();
  const saved = must(await host.saveEntry({draft: entryDraft('new-e', {title: '新条目'}), expectedVersion: null}));
  assert.equal(saved.entry.id, 'new-e');
  assert.equal(saved.token.revision, 2);
  const cat = must(await host.readCatalog()).data;
  assert.ok(cat.catalogEntries.some(e => e.id === 'new-e'));

  const rejected = await host.saveEntry({draft: entryDraft('new-e2'), expectedVersion: 1});
  assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.equal(rejected.code, 'INVALID_INPUT');
});

test('A2 updates an entry with the matching version, rejects stale reads', async () => {
  const host = makeHost();
  const current = must(await host.readCatalog()).data.catalogEntries.find(e => e.id === 'food-a')!;
  const stale = await host.saveEntry({draft: {...current, title: 'x'}, expectedVersion: 99});
  assert.equal(stale.ok, false);
  if (!stale) assert.fail();
  if (!stale.ok) assert.equal(stale.code, 'REVISION_CONFLICT');

  const saved = must(await host.saveEntry({draft: {...current, title: '改名餐'}, expectedVersion: 1}));
  assert.equal(saved.entry.version, 2);
  const after = must(await host.readCatalog()).data.catalogEntries.find(e => e.id === 'food-a')!;
  assert.equal(after.title, '改名餐');
  assert.equal(after.version, 2);
});

test('A2 creates a deck and rejects ghost members', async () => {
  const host = makeHost();
  must(await host.saveDeck({draft: deckDraft('new-deck', {name: '新堆'}), expectedVersion: null}));
  assert.ok(must(await host.readCatalog()).data.decks.some(d => d.id === 'new-deck'));

  const rejected = await host.saveDeck({draft: deckDraft('bad-deck', {memberIds: ['ghost']}), expectedVersion: null});
  assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.equal(rejected.code, 'INVALID_INPUT');
});

test('A2 rejects a parent cycle introduced across deck saves', async () => {
  const host = makeHost();
  must(await host.saveDeck({draft: deckDraft('da'), expectedVersion: null}));
  must(await host.saveDeck({draft: deckDraft('db'), expectedVersion: null}));
  // da -> db (valid)
  must(await host.saveDeck({draft: deckDraft('da', {parentDeckId: 'db'}), expectedVersion: 1}));
  // db -> da creates a cycle
  const rejected = await host.saveDeck({draft: deckDraft('db', {parentDeckId: 'da'}), expectedVersion: 1});
  assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.match(rejected.message, /PARENT_CYCLE/);
});

test('A2 reorders members within a deck and bumps its version', async () => {
  const host = makeHost();
  must(await host.saveEntry({draft: entryDraft('m1'), expectedVersion: null}));
  must(await host.saveEntry({draft: entryDraft('m2'), expectedVersion: null}));
  must(await host.saveDeck({draft: deckDraft('md', {memberIds: ['m1', 'm2']}), expectedVersion: null}));

  must(await host.moveMember({
    entry: {id: 'm2', version: 1}, from: {id: 'md', version: 1}, to: {id: 'md', version: 1}, targetIndex: 0,
  }));
  const deck = must(await host.readCatalog()).data.decks.find(d => d.id === 'md')!;
  assert.deepEqual([...deck.memberIds], ['m2', 'm1']);
  assert.equal(deck.version, 2);
});

test('A2 moves a member across decks of the same kind', async () => {
  const host = makeHost();
  must(await host.saveEntry({draft: entryDraft('m1'), expectedVersion: null}));
  must(await host.saveEntry({draft: entryDraft('m2'), expectedVersion: null}));
  must(await host.saveDeck({draft: deckDraft('md', {memberIds: ['m1', 'm2']}), expectedVersion: null}));
  must(await host.saveDeck({draft: deckDraft('md2'), expectedVersion: null}));

  must(await host.moveMember({
    entry: {id: 'm1', version: 1}, from: {id: 'md', version: 1}, to: {id: 'md2', version: 1}, targetIndex: 0,
  }));
  const cat = must(await host.readCatalog()).data;
  assert.deepEqual([...cat.decks.find(d => d.id === 'md')!.memberIds], ['m2']);
  assert.deepEqual([...cat.decks.find(d => d.id === 'md2')!.memberIds], ['m1']);
});

test('A2 rejects moving a member kind that does not match the target deck', async () => {
  const host = makeHost();
  must(await host.saveDeck({draft: deckDraft('md2'), expectedVersion: null}));
  const rejected = await host.moveMember({
    entry: {id: 'read', version: 1}, from: {id: 'md2', version: 1}, to: {id: 'md2', version: 1}, targetIndex: 0,
  });
  assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.equal(rejected.code, 'ENTRY_UNAVAILABLE');
});

test('A2 takeAction builds an action hand card and rejects stale/paused cards', async () => {
  const host = makeHost();
  const stale = await host.takeAction({action: {id: 'read', version: 99}});
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.equal(stale.code, 'REVISION_CONFLICT');

  const taken = must(await host.takeAction({action: {id: 'read', version: 1}}));
  assert.equal(taken.card.kind, 'action');
  if (taken.card.kind === 'action') {
    assert.deepEqual(taken.card.ownerAction, {id: 'read', version: 1});
    assert.equal(taken.card.contentSnapshot.title, '阅读《{对象}》');
    assert.equal(taken.card.provenance[0]!.kind, 'manual');
    assert.deepEqual(taken.card.fieldValues, []);
  }
  const hand = must(await host.readHand()).data;
  assert.equal(hand.length, 1);
  assert.equal(hand[0]!.usableInToday, true);
  assert.equal(hand[0]!.unavailableReason, null);
});

test('A2 takeEntry builds an entry card and rejects archived entries', async () => {
  const host = makeHost();
  const food = must(await host.readCatalog()).data.catalogEntries.find(e => e.id === 'food-a')!;
  must(await host.saveEntry({draft: {...food, status: 'archived'}, expectedVersion: 1}));
  const rejected = await host.takeEntry({entry: {id: 'food-a', version: 2}});
  assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.equal(rejected.code, 'ENTRY_UNAVAILABLE');

  const taken = must(await host.takeEntry({entry: {id: 'link-a', version: 1}}));
  assert.equal(taken.card.kind, 'entry');
  if (taken.card.kind === 'entry') assert.equal(taken.card.entrySnapshot.id, 'link-a');
});

test('A2 a decision save keeps owner/deck/mapping integrity', async () => {
  const host = makeHost();
  const draft: DecisionCard = {
    id: 'new-decision', version: 1, question: '今晚做什么？', ownerActionId: 'read',
    deckIds: ['books'], mappings: [{fieldId: 'subject', entryPath: 'title'}],
    status: 'active', source: {kind: 'manual'},
  };
  must(await host.saveDecision({draft, expectedVersion: null}));
  const bad: DecisionCard = {...draft, id: 'bad-decision', ownerActionId: 'ghost'};
  const rejected = await host.saveDecision({draft: bad, expectedVersion: null});
  assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.match(rejected.message, /BROKEN_OWNER_REF/);
});
