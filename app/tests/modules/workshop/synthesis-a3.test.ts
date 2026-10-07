import assert from 'node:assert/strict';
import test from 'node:test';
import type {CatalogEntry, CatalogV06, DecisionCard, Deck, HandCard} from '../../../src/workspace/v06.ts';
import {createInMemoryCatalogEditor, type CatalogEditorHost, type EditorResult} from '../../../src/workshop/catalog-editor.ts';
import {catalog as fixture, AT} from '../../support/v06/fixtures.ts';

const makeHost = (): CatalogEditorHost =>
  createInMemoryCatalogEditor(structuredClone(fixture), {now: () => AT});
const must = <T,>(r: EditorResult<T>): T => {
  if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
  return r.value;
};
const handCards = async (h: CatalogEditorHost): Promise<HandCard[]> =>
  must(await h.readHand()).data.map(i => i.card);
const ref = (c: HandCard) => ({id: c.id, version: c.version});

/** Take the read action and accept the which-book answer for the given entry. */
async function setupReadAndAnswer(h: CatalogEditorHost, entryId: string) {
  const action = must(await h.takeAction({action: {id: 'read', version: 1}})).card;
  const answer = must(await h.stageAnswerMaterial({
    decision: {id: 'which-book', version: 1}, entry: {id: entryId, version: 1},
  })).card;
  return {action, answer};
}

test('A3 stageAnswer builds a same-owner answer material', async () => {
  const h = makeHost();
  const {action, answer} = await setupReadAndAnswer(h, 'book-a');
  assert.equal(answer.kind, 'answer');
  if (answer.kind === 'answer') {
    assert.deepEqual(answer.answer.ownerAction, {id: 'read', version: 1});
    assert.deepEqual(answer.answer.fieldValues, [{fieldId: 'subject', value: '合成书目甲'}]);
  }
  assert.equal((await handCards(h)).length, 2);
  assert.notEqual(action.id, answer.id);
});

test('A3 happy synthesis fills the field and confirm replaces two with one composite', async () => {
  const h = makeHost();
  const {action, answer} = await setupReadAndAnswer(h, 'book-a');

  const preview = must(await h.previewSynthesis({inputs: [ref(action), ref(answer)], resolutions: []}));
  assert.equal(preview.ready, true);
  assert.equal(preview.conflicts.length, 0);
  assert.equal(preview.missingFieldIds.length, 0);
  assert.equal(preview.output.kind, 'composite');
  assert.deepEqual(preview.output.fieldValues, [{fieldId: 'subject', value: '合成书目甲'}]);
  assert.deepEqual(preview.output.ownerAction, {id: 'read', version: 1});
  assert.ok(preview.output.inputIds.includes(action.id) && preview.output.inputIds.includes(answer.id));

  must(await h.confirmSynthesis({previewId: preview.previewId}));
  const after = await handCards(h);
  assert.equal(after.length, 1);
  assert.equal(after[0]!.kind, 'composite');
  assert.equal(after[0]!.id, preview.output.id);
  // Inputs are gone from the active hand.
  assert.ok(!after.some(c => c.id === action.id || c.id === answer.id));
});

test('A3 step-synthesis conflict must be resolved keep/replace before confirm', async () => {
  const h = makeHost();
  // Add a second book to the books deck.
  const bookB: CatalogEntry = {
    id: 'book-b', version: 1, title: '合成书目乙', attributes: {}, url: null,
    status: 'active', source: {kind: 'manual'},
  };
  must(await h.saveEntry({draft: bookB, expectedVersion: null}));
  const books = must(await h.readCatalog()).data.decks.find(d => d.id === 'books')!;
  const booksNext: Deck = {...books, memberIds: [...books.memberIds, 'book-b']};
  must(await h.saveDeck({draft: booksNext, expectedVersion: 1}));

  // First synthesis: subject = 甲.
  let {action, answer} = await setupReadAndAnswer(h, 'book-a');
  let p = must(await h.previewSynthesis({inputs: [ref(action), ref(answer)], resolutions: []}));
  must(await h.confirmSynthesis({previewId: p.previewId}));
  const composite = (await handCards(h))[0]!;

  // Accept a second answer (乙) and synthesize with the existing composite.
  const answer2 = must(await h.stageAnswerMaterial({
    decision: {id: 'which-book', version: 1}, entry: {id: 'book-b', version: 1},
  })).card;

  p = must(await h.previewSynthesis({inputs: [ref(composite), ref(answer2)], resolutions: []}));
  assert.equal(p.ready, false);
  assert.equal(p.conflicts.length, 1);
  assert.deepEqual(p.conflicts[0], {fieldId: 'subject', previous: '合成书目甲', incoming: '合成书目乙'});

  const kept = must(await h.previewSynthesis({
    inputs: [ref(composite), ref(answer2)],
    resolutions: [{fieldId: 'subject', choice: 'keep'}],
  }));
  assert.equal(kept.ready, true);
  assert.equal(kept.output.fieldValues.find(f => f.fieldId === 'subject')!.value, '合成书目甲');

  const replaced = must(await h.previewSynthesis({
    inputs: [ref(composite), ref(answer2)],
    resolutions: [{fieldId: 'subject', choice: 'replace'}],
  }));
  assert.equal(replaced.output.fieldValues.find(f => f.fieldId === 'subject')!.value, '合成书目乙');

  must(await h.confirmSynthesis({previewId: replaced.previewId}));
  const finalHand = await handCards(h);
  assert.equal(finalHand.length, 1);
  assert.equal(finalHand[0]!.fieldValues.find(f => f.fieldId === 'subject')!.value, '合成书目乙');
  // Provenance/inputIds retain both sources.
  assert.ok(finalHand[0]!.inputIds.includes(composite.id) && finalHand[0]!.inputIds.includes(answer2.id));
});

test('A3 an answer owned by another action is rejected', async () => {
  const h = makeHost();
  const action = must(await h.takeAction({action: {id: 'read', version: 1}})).card;
  const wrongAnswer = must(await h.stageAnswerMaterial({
    decision: {id: 'which-food', version: 1}, entry: {id: 'food-a', version: 1},
  })).card;
  const r = await h.previewSynthesis({inputs: [ref(action), ref(wrongAnswer)], resolutions: []});
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, 'ACTION_OWNER_MISMATCH');
});

test('A3 a missing required field blocks readiness and confirm', async () => {
  const h = makeHost();
  // Decision with no mappings -> answer provides no subject.
  const noMap: DecisionCard = {
    id: 'read-nomap', version: 1, question: '无映射？', ownerActionId: 'read',
    deckIds: ['books'], mappings: [], status: 'active', source: {kind: 'manual'},
  };
  must(await h.saveDecision({draft: noMap, expectedVersion: null}));
  const action = must(await h.takeAction({action: {id: 'read', version: 1}})).card;
  const answer = must(await h.stageAnswerMaterial({
    decision: {id: 'read-nomap', version: 1}, entry: {id: 'book-a', version: 1},
  })).card;

  const p = must(await h.previewSynthesis({inputs: [ref(action), ref(answer)], resolutions: []}));
  assert.equal(p.ready, false);
  assert.deepEqual([...p.missingFieldIds], ['subject']);

  const rejected = await h.confirmSynthesis({previewId: p.previewId});
  assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.equal(rejected.code, 'REQUIRED_FIELD_EMPTY');
  // Both materials are retained (nothing half-consumed).
  assert.equal((await handCards(h)).length, 2);
});

test('A3 stageAnswer rejects an entry outside the decision candidate decks', async () => {
  const h = makeHost();
  must(await h.takeAction({action: {id: 'read', version: 1}}));
  // link-a lives in loose-list, which which-book does not use.
  const r = await h.stageAnswerMaterial({
    decision: {id: 'which-book', version: 1}, entry: {id: 'link-a', version: 1},
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, 'ENTRY_UNAVAILABLE');
});
