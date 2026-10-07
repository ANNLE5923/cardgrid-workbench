import assert from 'node:assert/strict';
import test from 'node:test';
import type {CatalogEntry, DecisionCard, Deck} from '../../../src/workspace/v06.ts';
import {createInMemoryCatalogEditor, type CatalogEditorHost, type EditorResult} from '../../../src/workshop/catalog-editor.ts';
import {catalog as fixture, AT} from '../../support/v06/fixtures.ts';

const makeHost = (rngValues?: number[]): CatalogEditorHost => {
  let i = 0;
  const rng = rngValues ? () => rngValues[i++ % rngValues.length]! : undefined;
  return createInMemoryCatalogEditor(structuredClone(fixture), {now: () => AT, rng});
};
const must = <T,>(r: EditorResult<T>): T => {
  if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
  return r.value;
};
const handCount = async (h: CatalogEditorHost): Promise<number> =>
  must(await h.readHand()).data.length;
const wb = {id: 'which-book', version: 1};

/** Add book-b to the books deck so draws can differ. */
async function addBookB(h: CatalogEditorHost) {
  const bookB: CatalogEntry = {id: 'book-b', version: 1, title: '合成书目乙', attributes: {},
    url: null, status: 'active', source: {kind: 'manual'}};
  must(await h.saveEntry({draft: bookB, expectedVersion: null}));
  const books = must(await h.readCatalog()).data.decks.find(d => d.id === 'books')!;
  const next: Deck = {...books, memberIds: [...books.memberIds, 'book-b']};
  must(await h.saveDeck({draft: next, expectedVersion: 1}));
}

test('A4 list candidates returns the active union', async () => {
  const h = makeHost();
  const view = must(await h.listDecisionCandidates({decision: wb}));
  assert.equal(view.candidates.length, 1);
  assert.deepEqual(view.candidates[0]!.entry, {id: 'book-a', version: 1});
  assert.deepEqual([...view.sourceDeckIds], ['books']);
});

test('A4 random draw uses the injected rng and does not add a hand card', async () => {
  const h = makeHost([0]);
  const p = must(await h.previewDecisionDraw({decision: wb, choice: {kind: 'random'}}));
  assert.equal(p.selected.entry.id, 'book-a');
  assert.deepEqual(p.selected.fieldValues, [{fieldId: 'subject', value: '合成书目甲'}]);
  assert.equal(p.sourceFingerprint, 'which-book@1:book-a@1');
  assert.equal(await handCount(h), 0); // previewing never adds a card
});

test('A4 redraw with rng sequence can flip between candidates', async () => {
  const h = makeHost([0, 0.99]);
  await addBookB(h);
  const first = must(await h.previewDecisionDraw({decision: wb, choice: {kind: 'random'}}));
  const second = must(await h.previewDecisionDraw({decision: wb, choice: {kind: 'random'}}));
  assert.equal(first.selected.entry.id, 'book-a');
  assert.equal(second.selected.entry.id, 'book-b');
  assert.equal(await handCount(h), 0);
});

test('A4 manual draw fixes the chosen entry; an outside entry is rejected', async () => {
  const h = makeHost();
  const p = must(await h.previewDecisionDraw({
    decision: wb, choice: {kind: 'manual', entry: {id: 'book-a', version: 1}},
  }));
  assert.equal(p.selected.entry.id, 'book-a');

  const outside = await h.previewDecisionDraw({
    decision: wb, choice: {kind: 'manual', entry: {id: 'link-a', version: 1}},
  });
  assert.equal(outside.ok, false);
  if (!outside.ok) assert.equal(outside.code, 'ENTRY_UNAVAILABLE');
});

test('A4 answer-only accept adds one card; with-action adds two', async () => {
  let h = makeHost();
  let p = must(await h.previewDecisionDraw({decision: wb, choice: {kind: 'random'}}));
  let r = must(await h.acceptDecisionAnswer({
    decision: wb, entry: {id: p.selected.entry.id, version: 1}, alsoTakeAction: false,
  }));
  assert.equal(r.action, null);
  assert.equal(r.answer.kind, 'answer');
  assert.equal(await handCount(h), 1);

  h = makeHost();
  p = must(await h.previewDecisionDraw({decision: wb, choice: {kind: 'random'}}));
  r = must(await h.acceptDecisionAnswer({
    decision: wb, entry: {id: p.selected.entry.id, version: 1}, alsoTakeAction: true,
  }));
  assert.equal(r.action!.kind, 'action');
  assert.equal(await handCount(h), 2);
});

test('A4 a decision with an empty candidate deck cannot draw', async () => {
  const h = makeHost();
  must(await h.saveDecision({draft: {id: 'read-empty', version: 1, question: '空？',
    ownerActionId: 'read', deckIds: ['empty-list'],
    mappings: [{fieldId: 'subject', entryPath: 'title'}], status: 'active',
    source: {kind: 'manual'}}, expectedVersion: null}));
  const r = await h.previewDecisionDraw({
    decision: {id: 'read-empty', version: 1}, choice: {kind: 'random'},
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, 'ENTRY_UNAVAILABLE');
});

test('A4 an archived decision cannot draw', async () => {
  const h = makeHost();
  const current = must(await h.readCatalog()).data.decisionCards.find(d => d.id === 'which-book')!;
  const archived: DecisionCard = {...current, status: 'archived'};
  must(await h.saveDecision({draft: archived, expectedVersion: 1}));
  const r = await h.previewDecisionDraw({
    decision: {id: 'which-book', version: 2}, choice: {kind: 'random'},
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, 'ENTRY_UNAVAILABLE');
});

test('A4 with-action accept is refused when the owner action is archived', async () => {
  const seed = structuredClone(fixture);
  seed.actionCards = seed.actionCards.map(a => a.id === 'read' ? {...a, status: 'archived'} : a);
  const h = createInMemoryCatalogEditor(seed, {now: () => AT});
  // The answer can still be previewed/fixed, but taking the action is refused.
  const p = must(await h.previewDecisionDraw({decision: wb, choice: {kind: 'random'}}));
  const r = await h.acceptDecisionAnswer({
    decision: wb, entry: {id: p.selected.entry.id, version: 1}, alsoTakeAction: true,
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, 'ENTRY_UNAVAILABLE');
  assert.equal(await handCount(h), 0); // nothing added on refusal
});
