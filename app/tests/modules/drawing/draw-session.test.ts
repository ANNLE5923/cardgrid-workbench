import test from 'node:test';
import assert from 'node:assert/strict';
import {
  INITIAL_SESSION, drawReducer, keyIntent, primaryAction, type DrawSession,
} from '../../../src/drawing/model.ts';
import type {
  BookEntry, DailyCopy, SlotSpec,
} from '../../../src/workspace/contracts-v3.ts';
import { content } from '../../fixtures/action/independent.ts';

const AT = '2026-10-01T02:00:00Z';

const book = (id: string, title: string, status: BookEntry['status'] = 'active'): BookEntry => ({
  id, version: 1, kind: 'book', title, author: null, status, source: { kind: 'manual' },
});
const requiredSlot: SlotSpec = { id: 'slot-book', label: '书名', poolId: 'pool-1', required: true, valueKind: 'entry' };

const copy = (over: Partial<DailyCopy> = {}): DailyCopy => ({
  id: 'copy-1', version: 1, ruleId: 'rule-1', ruleVersion: 1,
  actionCard: { id: 'card-1', version: 1 }, sourceDate: '2026-10-01', generatedAt: AT,
  contentSnapshot: content(), slotSpecSnapshot: [requiredSlot], status: 'active', acceptedInstanceIds: [],
  ...over,
});
const copyA = copy({ id: 'copyA', slotSpecSnapshot: [] });
const copyB = copy({ id: 'copyB', slotSpecSnapshot: [] });
const slotless = copy({ id: 'copy-plain', slotSpecSnapshot: [] });

function gotoCombo(copies: readonly DailyCopy[]): DrawSession {
  let s = drawReducer(INITIAL_SESSION, { type: 'start', copies });
  s = drawReducer(s, { type: 'first-tap', random: 0 });
  s = drawReducer(s, { type: 'second-tap' });
  return drawReducer(s, { type: 'continue-to-combo' });
}

test('first tap locks a copy id and the reveal keeps that same id', () => {
  let s = drawReducer(INITIAL_SESSION, { type: 'start', copies: [copy()] });
  s = drawReducer(s, { type: 'first-tap', random: 0 });
  assert.equal(s.phase.kind, 'presented');
  if (s.phase.kind === 'presented') assert.equal(s.phase.copyId, 'copy-1');
  s = drawReducer(s, { type: 'second-tap' });
  assert.equal(s.phase.kind, 'revealed');
  if (s.phase.kind === 'revealed') assert.equal(s.phase.copyId, 'copy-1');
});

test('the stop uses the random value to choose which today copy is locked', () => {
  const s1 = drawReducer(drawReducer(INITIAL_SESSION, { type: 'start', copies: [copyA, copyB] }),
    { type: 'first-tap', random: 0 });
  const s2 = drawReducer(drawReducer(INITIAL_SESSION, { type: 'start', copies: [copyA, copyB] }),
    { type: 'first-tap', random: 0.99 });
  assert.equal(s1.phase.kind, 'presented');
  if (s1.phase.kind === 'presented') assert.equal(s1.phase.copyId, 'copyA');
  if (s2.phase.kind === 'presented') assert.equal(s2.phase.copyId, 'copyB');
});

test('after the stop, extra first-tap events cannot swap the card', () => {
  let s = drawReducer(INITIAL_SESSION, { type: 'start', copies: [copyA, copyB] });
  s = drawReducer(s, { type: 'first-tap', random: 0 }); // locks copyA
  s = drawReducer(s, { type: 'first-tap', random: 0.99 }); // ignored at presented
  assert.equal(s.phase.kind, 'presented');
  if (s.phase.kind === 'presented') assert.equal(s.phase.copyId, 'copyA');
  s = drawReducer(s, { type: 'second-tap' });
  s = drawReducer(s, { type: 'first-tap', random: 0.99 }); // ignored at revealed
  if (s.phase.kind === 'revealed') assert.equal(s.phase.copyId, 'copyA');
});

test('a random slot pick is fixed once and not re-rolled by later events', () => {
  let s = gotoCombo([copy()]);
  s = drawReducer(s, { type: 'set-slot-mode', slotId: 'slot-book', mode: 'random' });
  s = drawReducer(s, {
    type: 'roll-slot', slotId: 'slot-book',
    candidates: [book('b1', '《百年孤独》'), book('b2', '《活着》')], random: 0,
  });
  assert.equal(s.phase.kind, 'combo');
  if (s.phase.kind === 'combo') {
    assert.equal(s.phase.selections[0].entryId, 'b1');
    assert.equal(s.phase.ready, true);
  }
  // A later unrelated event (e.g. editing text) must not re-roll the fixed entry.
  const later = drawReducer(s, { type: 'set-composed', text: '阅读《百年孤独》' });
  if (later.phase.kind === 'combo') assert.equal(later.phase.selections[0].entryId, 'b1');
});

test('switching slot mode clears a previous selection', () => {
  let s = gotoCombo([copy()]);
  s = drawReducer(s, { type: 'pick-slot', slotId: 'slot-book', entryId: 'b1' });
  s = drawReducer(s, { type: 'set-slot-mode', slotId: 'slot-book', mode: 'random' });
  if (s.phase.kind === 'combo') assert.equal(s.phase.selections[0].entryId, null);
});

test('required slot empty keeps the combo not ready; empty pool roll stays null; a pick makes it ready', () => {
  let s = gotoCombo([copy()]);
  if (s.phase.kind === 'combo') assert.equal(s.phase.ready, false);

  s = drawReducer(s, { type: 'set-slot-mode', slotId: 'slot-book', mode: 'random' });
  s = drawReducer(s, { type: 'roll-slot', slotId: 'slot-book', candidates: [], random: 0 });
  if (s.phase.kind === 'combo') {
    assert.equal(s.phase.selections[0].entryId, null);
    assert.equal(s.phase.ready, false);
  }

  s = drawReducer(s, { type: 'pick-slot', slotId: 'slot-book', entryId: 'b1' });
  if (s.phase.kind === 'combo') assert.equal(s.phase.ready, true);
});

test('a slotless copy is ready immediately in the combo', () => {
  const s = gotoCombo([slotless]);
  assert.equal(s.phase.kind, 'combo');
  if (s.phase.kind === 'combo') assert.equal(s.phase.ready, true);
});

test('cancel from any phase returns to the initial empty session', () => {
  const s = gotoCombo([copy()]);
  assert.deepEqual(drawReducer(s, { type: 'cancel' }), INITIAL_SESSION);
});

test('keyboard intent and per-phase primary action cover the full path', () => {
  assert.equal(keyIntent('Enter'), 'primary');
  assert.equal(keyIntent(' '), 'primary');
  assert.equal(keyIntent('Escape'), 'cancel');
  assert.equal(keyIntent('Tab'), null);

  assert.deepEqual(primaryAction({ kind: 'shuffling' }), 'first-tap');
  assert.deepEqual(primaryAction({ kind: 'presented', copyId: 'x' }), 'second-tap');
  assert.deepEqual(primaryAction({ kind: 'revealed', copyId: 'x' }), 'continue-to-combo');

  const ready = gotoCombo([slotless]);
  if (ready.phase.kind === 'combo') assert.equal(primaryAction(ready.phase), 'accept');
  const notReady = gotoCombo([copy()]);
  if (notReady.phase.kind === 'combo') assert.equal(primaryAction(notReady.phase), null);
});
